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
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[a-z0-9_-]{1,100}$/i;
const WORKER_ID = /^worker-[1-9][0-9]{0,9}$/;
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

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function requiredRunId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function optionalRequestId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error(`${label}_invalid`);
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

interface SwarmOwnerBinding {
  runId: string;
  primeConversationId: string | null;
  primeRequestId: string | undefined;
  dormant: boolean;
}

function parseWorkerInfo(raw: unknown, owner: SwarmOwnerBinding): { id: string; conversationId: string | null; row: NightBuildBridgeV2WorkerInput } {
  const info = object(raw, 'swarm_agent_info');
  const id = info['id'];
  const role = info['role'];
  const state = info['state'];
  if (role !== 'prime' && role !== 'worker') throw new Error('swarm_agent_role_invalid');
  if (typeof id !== 'string' || (role === 'prime' ? id !== 'prime' : !WORKER_ID.test(id))) throw new Error('swarm_agent_id_invalid');
  if (typeof state !== 'string' || !AGENT_STATES.includes(state as AgentState)) throw new Error('swarm_agent_state_invalid');
  if (requiredRunId(info['runId'], 'swarm_agent_run_id') !== owner.runId) throw new Error('swarm_agent_run_owner_mismatch');
  if (owner.primeConversationId === null) {
    if (!owner.primeRequestId || info['primeConversationId'] !== undefined) throw new Error('swarm_agent_prime_binding_invalid');
  } else if (info['primeConversationId'] !== owner.primeConversationId) {
    throw new Error('swarm_agent_prime_binding_invalid');
  }
  const conversationId = nullableString(info['conversationId'], 'swarm_agent_conversation_id');
  if (conversationId !== null && !ID.test(conversationId)) throw new Error('swarm_agent_conversation_id_invalid');
  if (role === 'prime' && conversationId !== owner.primeConversationId) throw new Error('swarm_prime_conversation_mismatch');
  if (role === 'worker' && conversationId !== null && conversationId === owner.primeConversationId) throw new Error('swarm_worker_conversation_conflict');
  if (owner.dormant && role === 'worker' && (state === 'invited' || state === 'active' || state === 'detached' || state === 'waking')) {
    throw new Error('swarm_dormant_worker_active');
  }
  const context = info['contextTokens'];
  const contextTokens = context === null ? 0 : safeInt(context, 'swarm_agent_context');
  return { id, conversationId, row: { role, state: state as AgentState, contextTokens } };
}

function parseAgentRows(raw: unknown[], owner: SwarmOwnerBinding): { rows: NightBuildBridgeV2WorkerInput[]; workerConversations: string[] } {
  const ids = new Set<string>();
  const conversations = new Set<string>();
  const workerConversations: string[] = [];
  let primes = 0;
  const rows = raw.map((entry) => {
    const row = object(entry, 'swarm_agent');
    if (!Array.isArray(row['queue'])) throw new Error('swarm_agent_queue_invalid');
    const parsed = parseWorkerInfo(row['info'], owner);
    if (ids.has(parsed.id)) throw new Error('swarm_agent_id_duplicate');
    ids.add(parsed.id);
    if (parsed.row.role === 'prime') primes += 1;
    if (parsed.conversationId !== null) {
      if (conversations.has(parsed.conversationId)) throw new Error('swarm_agent_conversation_duplicate');
      conversations.add(parsed.conversationId);
      if (parsed.row.role === 'worker') workerConversations.push(parsed.conversationId);
    }
    return parsed.row;
  });
  if (primes !== 1) throw new Error('swarm_prime_count_invalid');
  return { rows, workerConversations };
}

function dormantFamilyRunId(agents: unknown[]): string {
  let runId: string | null = null;
  for (const entry of agents) {
    const row = object(entry, 'swarm_agent');
    const info = object(row['info'], 'swarm_agent_info');
    if (info['id'] !== 'prime') continue;
    if (runId !== null) throw new Error('swarm_prime_count_invalid');
    runId = requiredRunId(info['runId'], 'swarm_dormant_run_id');
  }
  if (runId === null) throw new Error('swarm_prime_count_invalid');
  return runId;
}

function parseRunOwner(raw: unknown, dormant: boolean): { owner: SwarmOwnerBinding; agents: unknown[] } {
  const run = object(raw, dormant ? 'swarm_dormant_run' : 'swarm_active_run');
  const prime = run['primeConversationId'];
  const primeConversationId = prime === null ? null : requiredId(prime, dormant ? 'swarm_dormant_prime_conversation_id' : 'swarm_active_prime_conversation_id');
  const primeRequestId = optionalRequestId(run['primeRequestId'], dormant ? 'swarm_dormant_prime_request_id' : 'swarm_active_prime_request_id');
  if (primeConversationId === null && !primeRequestId) throw new Error(dormant ? 'swarm_dormant_prime_binding_invalid' : 'swarm_active_prime_binding_invalid');
  const agents = run['agents'];
  if (!Array.isArray(agents)) throw new Error('swarm_agents_invalid');
  safeInt(run['startedAt'], dormant ? 'swarm_dormant_started_at' : 'swarm_active_started_at', false);
  if (dormant) safeInt(run['parkedAt'], 'swarm_dormant_parked_at', false);
  const runId = dormant ? '' : requiredRunId(run['runId'], 'swarm_active_run_id');
  return { owner: { runId, primeConversationId, primeRequestId, dormant }, agents };
}

interface SwarmOwnership {
  workers: Set<string>;
  primes: Set<string>;
  ordinaryPrimes: Set<string>;
  requests: Set<string>;
}

function claimSwarmOwner(owner: SwarmOwnerBinding, workerConversations: string[], seen: SwarmOwnership): void {
  if (owner.primeRequestId && seen.requests.has(owner.primeRequestId)) throw new Error('swarm_prime_request_duplicate');
  if (owner.primeConversationId !== null) {
    if (seen.workers.has(owner.primeConversationId)) throw new Error('swarm_prime_worker_conflict');
    if (!owner.primeRequestId && seen.ordinaryPrimes.has(owner.primeConversationId)) throw new Error('swarm_prime_conversation_duplicate');
  }
  for (const conversationId of workerConversations) {
    if (seen.workers.has(conversationId) || seen.primes.has(conversationId)) throw new Error('swarm_worker_conversation_duplicate');
  }
  for (const conversationId of workerConversations) seen.workers.add(conversationId);
  if (owner.primeConversationId !== null) {
    seen.primes.add(owner.primeConversationId);
    if (!owner.primeRequestId) seen.ordinaryPrimes.add(owner.primeConversationId);
  }
  if (owner.primeRequestId) seen.requests.add(owner.primeRequestId);
}

function parseSwarm(raw: unknown | null, enabled: boolean): NightBuildBridgeV2Snapshot['workers'] {
  if (raw === null) return { enabled, running: false, retainedHistory: false, rows: [] };
  const root = object(raw, 'swarm');
  if (root['version'] !== 7) throw new Error('swarm_version_invalid');
  if (!Array.isArray(root['activeRuns']) || !Array.isArray(root['dormantRuns'])) throw new Error('swarm_runs_invalid');
  if (root['activeRuns'].length > MAX_SWARM_RUNS || root['dormantRuns'].length > MAX_SWARM_RUNS) throw new Error('swarm_run_limit');
  safeInt(root['savedAt'], 'swarm_saved_at', false);
  const active = root['activeRuns'].map((run) => parseRunOwner(run, false));
  const dormant = root['dormantRuns'].map((run) => parseRunOwner(run, true));
  const agentCount = [...active, ...dormant].reduce((sum, run) => sum + run.agents.length, 0);
  if (agentCount > MAX_SWARM_AGENTS) throw new Error('swarm_agent_limit');
  const rows: NightBuildBridgeV2WorkerInput[] = [];
  const familyIds = new Set<string>();
  const ownership: SwarmOwnership = { workers: new Set(), primes: new Set(), ordinaryPrimes: new Set(), requests: new Set() };
  for (const run of active) {
    if (familyIds.has(run.owner.runId)) throw new Error('swarm_run_id_duplicate');
    familyIds.add(run.owner.runId);
    const parsed = parseAgentRows(run.agents, run.owner);
    claimSwarmOwner(run.owner, parsed.workerConversations, ownership);
    rows.push(...parsed.rows);
  }
  for (const run of dormant) {
    const runId = dormantFamilyRunId(run.agents);
    if (familyIds.has(runId)) throw new Error('swarm_run_id_duplicate');
    familyIds.add(runId);
    const owner = { ...run.owner, runId };
    const parsed = parseAgentRows(run.agents, owner);
    claimSwarmOwner(owner, parsed.workerConversations, ownership);
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
