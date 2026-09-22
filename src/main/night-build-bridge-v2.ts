import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentState, TurnOutcome } from '../shared/session.js';
import type { GoalMode } from '../shared/types.js';
import {
  NIGHT_BUILD_BRIDGE_V2_CAPABILITIES,
  NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE,
  NIGHT_BUILD_BRIDGE_V2_PROTOCOL,
  type NightBuildBridgeObservationMode,
  type NightBuildBridgeV2Discovery,
  type NightBuildBridgeV2DraftCounts,
  type NightBuildBridgeV2Status
} from '../shared/night-build-bridge-v2.js';
import { APP_VERSION } from './version.js';

const HOST = '127.0.0.1' as const;
const MAX_URL_CHARS = 512;
const OWNERSHIP_POLL_MS = 1_000;
const AGENT_STATES: AgentState[] = ['invited', 'active', 'detached', 'waking', 'sleeping', 'finished', 'failed'];
const TURN_OUTCOMES: TurnOutcome[] = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'];

export interface NightBuildBridgeV2FeatureInput {
  recording: boolean;
  multiAgent: boolean;
  goal: boolean;
  compactionAuto: boolean;
  advisoryTokens: number;
  limitTokens: number;
  autoCompactionTokens: number;
}

export interface NightBuildBridgeV2SessionInput {
  conversationId: string | null;
  updatedAt: number;
  events: number;
  userMessages: number;
  toolCalls: number;
  errors: number;
  toolRejected: number;
  processExitNonzero: number;
  contextTokens: number;
  estimatedTokens: number;
  lastToolCallAt: number | null;
  lastAssistantFinalAt: number | null;
  lastTurnEndAt: number | null;
  lastHandoffAt: number | null;
  lastCommittedResumeHandoffId: string | null;
  lastTurnOutcome: TurnOutcome | null;
  activeTurnId: string | null;
}

export interface NightBuildBridgeV2GoalInput {
  enabled: boolean;
  mode: GoalMode;
  objectivePresent: boolean;
  armed: boolean;
  draft: null | { stage: 'sending' | 'answering' | 'ready' | 'no-reply' | 'failed'; retryable: boolean };
}

export interface NightBuildBridgeV2WorkerInput {
  role: 'prime' | 'worker';
  state: AgentState;
  contextTokens: number;
}

export interface NightBuildBridgeV2Snapshot {
  features: NightBuildBridgeV2FeatureInput;
  sessions: { total: number; rows: NightBuildBridgeV2SessionInput[] };
  goal: {
    enabled: boolean;
    mode: GoalMode;
    rows: NightBuildBridgeV2GoalInput[];
    draftsObserved: boolean;
  };
  workers: {
    enabled: boolean;
    running: boolean;
    retainedHistory: boolean;
    rows: NightBuildBridgeV2WorkerInput[];
  };
}

export interface NightBuildBridgeV2DataSource {
  observationMode: NightBuildBridgeObservationMode;
  controllerStartedAt: number;
  snapshot(): Promise<NightBuildBridgeV2Snapshot>;
}

export interface NightBuildBridgeV2Handle {
  discovery: NightBuildBridgeV2Discovery;
  stop(): Promise<void>;
  /** Deterministic seam used by tests; production also invokes it on a timer. */
  checkOwnershipNow(): Promise<boolean>;
}

export interface NightBuildBridgeV2StartOptions {
  appVersion?: string;
  bridgePid?: number;
  bridgeStartedAt?: number;
  ownerIsCurrent?: () => Promise<boolean>;
  ownershipPollMs?: number;
}

function latestTimestamp(values: Array<number | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (latest === null || (value as number) > latest) latest = value as number;
  }
  return latest;
}

function nonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
}

export function aggregateNightBuildBridgeV2Sessions(
  features: NightBuildBridgeV2FeatureInput,
  rows: NightBuildBridgeV2SessionInput[],
  total: number
): NightBuildBridgeV2Status['sessions'] {
  const outcomes = Object.fromEntries([...TURN_OUTCOMES, 'unreported'].map((value) => [value, 0])) as NightBuildBridgeV2Status['sessions']['outcomes'];
  let events = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let errors = 0;
  let toolRejected = 0;
  let processExitNonzero = 0;
  let maxEstimatedContextTokens = 0;
  let maxEstimatedSessionTokens = 0;
  let sessionsAtOrAboveAdvisory = 0;
  let sessionsAtOrAboveAutoCompaction = 0;
  let sessionsWithHandoff = 0;
  let sessionsWithCommittedResume = 0;
  for (const row of rows) {
    const contextTokens = nonnegative(row.contextTokens);
    const estimatedTokens = nonnegative(row.estimatedTokens);
    events += nonnegative(row.events);
    userMessages += nonnegative(row.userMessages);
    toolCalls += nonnegative(row.toolCalls);
    errors += nonnegative(row.errors);
    toolRejected += nonnegative(row.toolRejected);
    processExitNonzero += nonnegative(row.processExitNonzero);
    maxEstimatedContextTokens = Math.max(maxEstimatedContextTokens, contextTokens);
    maxEstimatedSessionTokens = Math.max(maxEstimatedSessionTokens, estimatedTokens);
    if (contextTokens >= features.advisoryTokens) sessionsAtOrAboveAdvisory += 1;
    if (contextTokens >= features.autoCompactionTokens) sessionsAtOrAboveAutoCompaction += 1;
    if (row.lastHandoffAt !== null) sessionsWithHandoff += 1;
    if (row.lastCommittedResumeHandoffId) sessionsWithCommittedResume += 1;
    outcomes[row.lastTurnOutcome && TURN_OUTCOMES.includes(row.lastTurnOutcome) ? row.lastTurnOutcome : 'unreported'] += 1;
  }
  return {
    listedTotal: total,
    observed: rows.length,
    activeTurns: rows.filter((row) => row.activeTurnId !== null).length,
    lastUpdatedAt: latestTimestamp(rows.map((row) => row.updatedAt)),
    context: { maxEstimatedContextTokens, maxEstimatedSessionTokens, sessionsAtOrAboveAdvisory, sessionsAtOrAboveAutoCompaction },
    activity: {
      events,
      userMessages,
      toolCalls,
      errors,
      toolRejected,
      processExitNonzero,
      lastToolCallAt: latestTimestamp(rows.map((row) => row.lastToolCallAt)),
      lastAssistantFinalAt: latestTimestamp(rows.map((row) => row.lastAssistantFinalAt)),
      lastTurnEndAt: latestTimestamp(rows.map((row) => row.lastTurnEndAt))
    },
    compaction: {
      sessionsWithHandoff,
      sessionsWithCommittedResume,
      lastHandoffAt: latestTimestamp(rows.map((row) => row.lastHandoffAt))
    },
    outcomes
  };
}

export function aggregateNightBuildBridgeV2Goal(input: NightBuildBridgeV2Snapshot['goal']): NightBuildBridgeV2Status['goal'] {
  const drafts: NightBuildBridgeV2DraftCounts = { sending: 0, answering: 0, ready: 0, noReply: 0, failed: 0, retryableFailed: 0 };
  let objectivePresent = 0;
  let armed = 0;
  for (const row of input.rows) {
    if (row.objectivePresent) objectivePresent += 1;
    if (row.armed) armed += 1;
    if (!input.draftsObserved || !row.draft) continue;
    if (row.draft.stage === 'no-reply') drafts.noReply += 1;
    else drafts[row.draft.stage] += 1;
    if (row.draft.stage === 'failed' && row.draft.retryable) drafts.retryableFailed += 1;
  }
  return { enabled: input.enabled, mode: input.mode, objectivePresent, armed, draftsObserved: input.draftsObserved, drafts: input.draftsObserved ? drafts : null };
}

export function aggregateNightBuildBridgeV2Workers(input: NightBuildBridgeV2Snapshot['workers']): NightBuildBridgeV2Status['workers'] {
  const stateCounts = Object.fromEntries(AGENT_STATES.map((state) => [state, 0])) as Record<AgentState, number>;
  let workerCount = 0;
  let activeWorkers = 0;
  let sleepingWorkers = 0;
  let terminalWorkers = 0;
  let maxEstimatedContextTokens = 0;
  for (const row of input.rows) {
    stateCounts[row.state] += 1;
    maxEstimatedContextTokens = Math.max(maxEstimatedContextTokens, nonnegative(row.contextTokens));
    if (row.role !== 'worker') continue;
    workerCount += 1;
    if (row.state === 'invited' || row.state === 'active' || row.state === 'detached' || row.state === 'waking') activeWorkers += 1;
    else if (row.state === 'sleeping') sleepingWorkers += 1;
    else if (row.state === 'finished' || row.state === 'failed') terminalWorkers += 1;
  }
  return {
    enabled: input.enabled,
    running: input.running,
    retainedHistory: input.retainedHistory,
    totalAgents: input.rows.length,
    workerCount,
    activeWorkers,
    sleepingWorkers,
    terminalWorkers,
    stateCounts,
    maxEstimatedContextTokens
  };
}

export async function projectNightBuildBridgeV2Status(
  source: NightBuildBridgeV2DataSource,
  discovery: NightBuildBridgeV2Discovery
): Promise<NightBuildBridgeV2Status> {
  const snapshot = await source.snapshot();
  return {
    protocolVersion: NIGHT_BUILD_BRIDGE_V2_PROTOCOL,
    appVersion: discovery.appVersion,
    observedAt: Date.now(),
    capabilities: [...NIGHT_BUILD_BRIDGE_V2_CAPABILITIES],
    bridge: { observationMode: source.observationMode, startedAt: discovery.startedAt },
    controller: { running: true, startedAt: source.controllerStartedAt },
    features: snapshot.features,
    sessions: aggregateNightBuildBridgeV2Sessions(snapshot.features, snapshot.sessions.rows, snapshot.sessions.total),
    goal: aggregateNightBuildBridgeV2Goal(snapshot.goal),
    workers: aggregateNightBuildBridgeV2Workers(snapshot.workers)
  };
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const expected = Buffer.from('Bearer ' + token);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff'
  });
  res.end(bytes);
}

function hasRequestBody(req: http.IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const raw = req.headers['content-length'];
  if (raw === undefined) return false;
  const length = Number(Array.isArray(raw) ? raw[0] : raw);
  return !Number.isFinite(length) || length !== 0;
}

function requestHandler(
  source: NightBuildBridgeV2DataSource,
  discovery: NightBuildBridgeV2Discovery,
  statusAllowed: () => Promise<boolean>
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'read_only' });
      if (hasRequestBody(req)) return writeJson(res, 400, { error: 'request_body_forbidden' });
      if (!req.url || req.url.length > MAX_URL_CHARS) return writeJson(res, 400, { error: 'bad_request' });
      if (req.headers.origin !== undefined) return writeJson(res, 403, { error: 'browser_origin_forbidden' });
      if (!bearerMatches(req.headers.authorization, discovery.token)) return writeJson(res, 401, { error: 'unauthorized' });
      if (req.headers['x-night-build-protocol'] !== String(NIGHT_BUILD_BRIDGE_V2_PROTOCOL)) {
        return writeJson(res, 426, { error: 'protocol_mismatch', supportedProtocol: NIGHT_BUILD_BRIDGE_V2_PROTOCOL });
      }
      if (req.url !== '/v2/status') return writeJson(res, 404, { error: 'not_found' });
      if (!(await statusAllowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      writeJson(res, 200, await projectNightBuildBridgeV2Status(source, discovery));
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  };
}

function discoveryPath(userData: string): string {
  return path.join(userData, NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE);
}

async function sameBytes(file: string, ownedBytes: Buffer): Promise<boolean> {
  try {
    const current = await fs.readFile(file);
    return current.length === ownedBytes.length && timingSafeEqual(current, ownedBytes);
  } catch {
    return false;
  }
}

async function publishDiscoveryExclusive(userData: string, discovery: NightBuildBridgeV2Discovery): Promise<{ file: string; bytes: Buffer }> {
  const file = discoveryPath(userData);
  const bytes = Buffer.from(JSON.stringify(discovery) + '\n');
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  return { file, bytes };
}

async function conditionalUnlink(file: string, ownedBytes: Buffer): Promise<void> {
  if (await sameBytes(file, ownedBytes)) await fs.rm(file, { force: true });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const force = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 5_000);
    force.unref?.();
    server.close(() => {
      clearTimeout(force);
      finish();
    });
    server.closeIdleConnections?.();
  });
}

export async function startNightBuildBridgeV2(
  userData: string,
  source: NightBuildBridgeV2DataSource,
  options: NightBuildBridgeV2StartOptions = {}
): Promise<NightBuildBridgeV2Handle> {
  const seed: NightBuildBridgeV2Discovery = {
    protocolVersion: NIGHT_BUILD_BRIDGE_V2_PROTOCOL,
    appVersion: options.appVersion ?? APP_VERSION,
    instanceId: randomUUID(),
    pid: options.bridgePid ?? process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: options.bridgeStartedAt ?? Date.now()
  };
  let statusAllowed = async (): Promise<boolean> => true;
  const server = http.createServer({ maxHeaderSize: 8192 }, requestHandler(source, seed, () => statusAllowed()));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once('error', failed);
    server.listen(0, HOST, () => { server.off('error', failed); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== HOST) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Night Build v2 bridge did not bind loopback');
  }
  seed.port = address.port;
  const discovery = { ...seed };
  let publication: { file: string; bytes: Buffer };
  try {
    publication = await publishDiscoveryExclusive(userData, discovery);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (stopped) return;
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      await conditionalUnlink(publication.file, publication.bytes);
      await closeServer(server);
    })();
    return stopping;
  };
  const checkOwnershipNow = async (): Promise<boolean> => {
    if (stopped) return false;
    if (!(await sameBytes(publication.file, publication.bytes))) { await stop(); return false; }
    if (options.ownerIsCurrent && !(await options.ownerIsCurrent())) { await stop(); return false; }
    return true;
  };
  statusAllowed = async () => {
    if (!(await sameBytes(publication.file, publication.bytes))) return false;
    return options.ownerIsCurrent ? options.ownerIsCurrent() : true;
  };
  const pollMs = options.ownershipPollMs ?? OWNERSHIP_POLL_MS;
  if (options.ownerIsCurrent || pollMs > 0) {
    timer = setInterval(() => { void checkOwnershipNow().catch(() => stop()); }, Math.max(10, pollMs));
    timer.unref?.();
  }
  return { discovery, stop, checkOwnershipNow };
}
