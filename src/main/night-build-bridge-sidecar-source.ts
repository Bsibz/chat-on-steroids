import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentState, TurnOutcome } from '../shared/session.js';
import type { GoalMode } from '../shared/types.js';
import type {
  NightBuildBridgeV2DataSource,
  NightBuildBridgeV2FeatureInput,
  NightBuildBridgeV2GoalInput,
  NightBuildBridgeV2SessionInput,
  NightBuildBridgeV2Snapshot,
  NightBuildBridgeV2WorkerInput
} from './night-build-bridge-v2.js';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_DURABLE_BYTES = 8 * 1024 * 1024;
const MAX_META_BYTES = 1024 * 1024;
const MAX_SESSION_DIRECTORIES = 5_000;
const MAX_OBSERVED_SESSIONS = 50;
const MAX_GOAL_ROWS = 10_000;
const MAX_SWARM_RUNS = 128;
const MAX_SWARM_AGENTS = 4_096;
const ID = /^[0-9a-z-]{8,256}$/i;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const AGENT_STATES: readonly AgentState[] = ['invited', 'active', 'detached', 'waking', 'sleeping', 'finished', 'failed'];
const OUTCOMES: readonly TurnOutcome[] = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'];

type JsonObject = Record<string, unknown>;

export interface DurableSidecarOwner {
  startedAt: number;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as JsonObject;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}_invalid`);
  return value;
}

function safeInt(value: unknown, label: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) throw new Error(`${label}_invalid`);
  return value as number;
}

function nullableTimestamp(value: unknown, label: string): number | null {
  if (value === null) return null;
  return safeInt(value, label);
}

function nullableString(value: unknown, label: string, max = 256): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label}_invalid`);
  return value;
}

function goalMode(value: unknown, label: string): GoalMode {
  if (value !== 'goal' && value !== 'loop') throw new Error(`${label}_invalid`);
  return value;
}

async function readJson(file: string, maxBytes: number, optional = false): Promise<unknown | null> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('durable_json_size_invalid');
  const raw = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('durable_json_size_invalid');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('durable_json_invalid');
  }
}

function parseFeatures(raw: unknown): { features: NightBuildBridgeV2FeatureInput; goalMode: GoalMode } {
  const root = object(raw, 'config');
  const sessions = object(root['sessions'], 'config_sessions');
  const compaction = object(root['compaction'], 'config_compaction');
  const multiAgent = object(root['multiAgent'], 'config_multi_agent');
  const goal = object(root['goal'], 'config_goal');
  const mode = goalMode(goal['mode'], 'config_goal_mode');
  return {
    features: {
      recording: bool(sessions['record'], 'config_recording'),
      multiAgent: bool(multiAgent['enabled'], 'config_multi_agent_enabled'),
      goal: bool(goal['enabled'], 'config_goal_enabled'),
      compactionAuto: bool(compaction['auto'], 'config_compaction_auto'),
      advisoryTokens: safeInt(sessions['advisoryTokens'], 'config_advisory_tokens', false),
      limitTokens: safeInt(sessions['limitTokens'], 'config_limit_tokens', false),
      autoCompactionTokens: safeInt(compaction['autoTokens'], 'config_auto_compaction_tokens', false)
    },
    goalMode: mode
  };
}

function parseSession(raw: unknown, directoryId: string): { helper: boolean; row: NightBuildBridgeV2SessionInput } {
  const value = object(raw, 'session_meta');
  if (value['id'] !== directoryId) throw new Error('session_id_mismatch');
  const origin = value['origin'];
  let helper = false;
  if (origin !== null) {
    const originObject = object(origin, 'session_origin');
    if (typeof originObject['kind'] !== 'string') throw new Error('session_origin_kind_invalid');
    helper = originObject['kind'] === 'helper';
  }
  const outcome = value['lastTurnOutcome'];
  if (outcome !== null && (typeof outcome !== 'string' || !OUTCOMES.includes(outcome as TurnOutcome))) throw new Error('session_outcome_invalid');
  const conversationId = nullableString(value['conversationId'], 'session_conversation_id');
  if (conversationId !== null && !ID.test(conversationId)) throw new Error('session_conversation_id_invalid');
  return {
    helper,
    row: {
      conversationId,
      updatedAt: safeInt(value['updatedAt'], 'session_updated_at'),
      events: safeInt(value['events'], 'session_events'),
      userMessages: safeInt(value['userMessages'], 'session_user_messages'),
      toolCalls: safeInt(value['toolCalls'], 'session_tool_calls'),
      errors: safeInt(value['errors'], 'session_errors'),
      toolRejected: safeInt(value['toolRejected'], 'session_tool_rejected'),
      processExitNonzero: safeInt(value['processExitNonzero'], 'session_process_exit_nonzero'),
      contextTokens: safeInt(value['contextTokens'], 'session_context_tokens'),
      estimatedTokens: safeInt(value['estimatedTokens'], 'session_estimated_tokens'),
      lastToolCallAt: nullableTimestamp(value['lastToolCallAt'], 'session_last_tool_call'),
      lastAssistantFinalAt: nullableTimestamp(value['lastAssistantFinalAt'], 'session_last_assistant_final'),
      lastTurnEndAt: nullableTimestamp(value['lastTurnEndAt'], 'session_last_turn_end'),
      lastHandoffAt: nullableTimestamp(value['lastHandoffAt'], 'session_last_handoff'),
      lastCommittedResumeHandoffId: nullableString(value['lastCommittedResumeHandoffId'], 'session_resume_handoff_id'),
      lastTurnOutcome: outcome as TurnOutcome | null,
      activeTurnId: nullableString(value['activeTurnId'], 'session_active_turn_id')
    }
  };
}

async function readSessions(userData: string): Promise<{ total: number; rows: NightBuildBridgeV2SessionInput[] }> {
  const root = path.join(userData, 'sessions');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, rows: [] };
    throw error;
  }
  const candidates = names.filter((name) => SESSION_ID.test(name));
  if (candidates.length > MAX_SESSION_DIRECTORIES) throw new Error('session_directory_limit');
  const sessions: NightBuildBridgeV2SessionInput[] = [];
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async (id) => {
      const raw = await readJson(path.join(root, id, 'meta.json'), MAX_META_BYTES, true);
      return raw === null ? null : parseSession(raw, id);
    }));
    for (const row of batch) if (row && !row.helper) sessions.push(row.row);
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  return { total: sessions.length, rows: sessions.slice(0, MAX_OBSERVED_SESSIONS) };
}

function parseObjectives(raw: unknown | null): Set<string> {
  if (raw === null) return new Set();
  const root = object(raw, 'goal_objectives');
  if (root['version'] !== 1 || !Array.isArray(root['objectives']) || root['objectives'].length > MAX_GOAL_ROWS) throw new Error('goal_objectives_invalid');
  const result = new Set<string>();
  for (const entry of root['objectives']) {
    const row = object(entry, 'goal_objective');
    const conversationId = row['conversationId'];
    const objective = row['objective'];
    if (typeof conversationId !== 'string' || !ID.test(conversationId) || typeof objective !== 'string' || objective.trim().length === 0) throw new Error('goal_objective_invalid');
    result.add(conversationId);
  }
  return result;
}

interface DurableSwitch { enabled: boolean; mode: GoalMode; decision: boolean }

function parseSwitches(raw: unknown | null): Map<string, DurableSwitch> {
  if (raw === null) return new Map();
  const root = object(raw, 'goal_switches');
  if (root['version'] !== 1 || !Array.isArray(root['switches']) || root['switches'].length > MAX_GOAL_ROWS) throw new Error('goal_switches_invalid');
  const result = new Map<string, DurableSwitch>();
  for (const entry of root['switches']) {
    const row = object(entry, 'goal_switch');
    const conversationId = row['conversationId'];
    if (typeof conversationId !== 'string' || !ID.test(conversationId)) throw new Error('goal_switch_conversation_invalid');
    const mode = goalMode(row['mode'], 'goal_switch_mode');
    const enabled = bool(row['enabled'], 'goal_switch_enabled');
    safeInt(row['at'], 'goal_switch_at', false);
    const role = row['role'];
    if (role !== undefined && role !== 'decision') throw new Error('goal_switch_role_invalid');
    result.set(conversationId, { enabled: role === 'decision' ? false : enabled, mode, decision: role === 'decision' });
  }
  return result;
}

function durableGoalRows(
  configEnabled: boolean,
  configMode: GoalMode,
  sessions: NightBuildBridgeV2SessionInput[],
  objectives: Set<string>,
  switches: Map<string, DurableSwitch>
): NightBuildBridgeV2GoalInput[] {
  const seen = new Set<string>();
  const rows: NightBuildBridgeV2GoalInput[] = [];
  for (const session of sessions) {
    const conversationId = session.conversationId;
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    const own = switches.get(conversationId);
    const objectivePresent = objectives.has(conversationId);
    const enabled = own ? own.enabled : configEnabled;
    rows.push({
      enabled,
      mode: own?.mode ?? configMode,
      objectivePresent,
      armed: own ? own.enabled : configEnabled || objectivePresent,
      draft: null
    });
  }
  return rows;
}

function parseWorkerInfo(raw: unknown): NightBuildBridgeV2WorkerInput {
  const info = object(raw, 'swarm_agent_info');
  const role = info['role'];
  const state = info['state'];
  if (role !== 'prime' && role !== 'worker') throw new Error('swarm_agent_role_invalid');
  if (typeof state !== 'string' || !AGENT_STATES.includes(state as AgentState)) throw new Error('swarm_agent_state_invalid');
  const context = info['contextTokens'];
  const contextTokens = context === null ? 0 : safeInt(context, 'swarm_agent_context');
  return { role, state: state as AgentState, contextTokens };
}

function parseAgentRows(raw: unknown): NightBuildBridgeV2WorkerInput[] {
  if (!Array.isArray(raw)) throw new Error('swarm_agents_invalid');
  return raw.map((entry) => {
    const row = object(entry, 'swarm_agent');
    if (!Array.isArray(row['queue'])) throw new Error('swarm_agent_queue_invalid');
    return parseWorkerInfo(row['info']);
  });
}

function parseSwarm(raw: unknown | null, enabled: boolean): NightBuildBridgeV2Snapshot['workers'] {
  if (raw === null) return { enabled, running: false, retainedHistory: false, rows: [] };
  const root = object(raw, 'swarm');
  if (root['version'] !== 6 && root['version'] !== 7) throw new Error('swarm_version_invalid');
  if (!Array.isArray(root['activeRuns']) || !Array.isArray(root['dormantRuns'])) throw new Error('swarm_runs_invalid');
  if (root['activeRuns'].length > MAX_SWARM_RUNS || root['dormantRuns'].length > MAX_SWARM_RUNS) throw new Error('swarm_run_limit');
  const rows: NightBuildBridgeV2WorkerInput[] = [];
  let parsedAgents = 0;
  for (const rawRun of root['activeRuns']) {
    const run = object(rawRun, 'swarm_active_run');
    const active = parseAgentRows(run['agents']);
    parsedAgents += active.length;
    rows.push(...active);
    if (parsedAgents > MAX_SWARM_AGENTS) throw new Error('swarm_agent_limit');
  }
  for (const rawRun of root['dormantRuns']) {
    const run = object(rawRun, 'swarm_dormant_run');
    parsedAgents += parseAgentRows(run['agents']).length;
    if (parsedAgents > MAX_SWARM_AGENTS) throw new Error('swarm_agent_limit');
  }
  return { enabled, running: root['activeRuns'].length > 0, retainedHistory: root['dormantRuns'].length > 0, rows };
}

export async function readDurableSidecarSnapshot(userData: string): Promise<NightBuildBridgeV2Snapshot> {
  const configRaw = await readJson(path.join(userData, 'config.json'), MAX_CONFIG_BYTES);
  const { features, goalMode: configuredMode } = parseFeatures(configRaw);
  const sessions = await readSessions(userData);
  const stateRoot = path.join(userData, 'state');
  const [objectivesRaw, switchesRaw, swarmRaw] = await Promise.all([
    readJson(path.join(stateRoot, 'goal-objectives.json'), MAX_DURABLE_BYTES, true),
    readJson(path.join(stateRoot, 'goal-switches.json'), MAX_DURABLE_BYTES, true),
    readJson(path.join(stateRoot, 'swarm.json'), MAX_DURABLE_BYTES, true)
  ]);
  const objectives = parseObjectives(objectivesRaw);
  const switches = parseSwitches(switchesRaw);
  return {
    features,
    sessions,
    goal: {
      enabled: features.goal,
      mode: configuredMode,
      rows: durableGoalRows(features.goal, configuredMode, sessions.rows, objectives, switches),
      draftsObserved: false
    },
    workers: parseSwarm(swarmRaw, features.multiAgent)
  };
}

export function createDurableSidecarSource(userData: string, owner: DurableSidecarOwner): NightBuildBridgeV2DataSource {
  return {
    observationMode: 'durable-sidecar',
    controllerStartedAt: owner.startedAt,
    snapshot: () => readDurableSidecarSnapshot(userData)
  };
}
