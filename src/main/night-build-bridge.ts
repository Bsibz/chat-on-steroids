import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentState, SessionSummary, SwarmState, TurnOutcome } from '../shared/session.js';
import type { Config, ConnectionStatus } from '../shared/types.js';
import {
  NIGHT_BUILD_BRIDGE_DISCOVERY_FILE,
  NIGHT_BUILD_BRIDGE_PROTOCOL,
  type NightBuildBridgeDiscovery,
  type NightBuildBridgeStatus,
  type NightBuildCapability
} from '../shared/night-build-bridge.js';
import { bridgeObserverStatus } from './bridge.js';
import { getConfig } from './config.js';
import { getStatus } from './connection.js';
import { goalObserverFor } from './goal.js';
import { swarmState } from './agents.js';
import { APP_VERSION } from './version.js';
import { peekSessionPage } from './session/store.js';
import { logInfo, logWarn } from './logger.js';

const HOST = '127.0.0.1' as const;
const OBSERVED_SESSION_LIMIT = 50;
const MAX_URL_CHARS = 512;
const AGENT_STATES: AgentState[] = [
  'invited',
  'active',
  'detached',
  'waking',
  'sleeping',
  'finished',
  'failed'
];
const TURN_OUTCOMES: TurnOutcome[] = [
  'completed',
  'failed',
  'stopped',
  'interrupted',
  'stalled',
  'unknown'
];
const CAPABILITIES: NightBuildCapability[] = [
  'status',
  'sessions',
  'activity',
  'goal',
  'agents',
  'browser-automation',
  'context'
];

type BrowserStatus = Awaited<ReturnType<typeof bridgeObserverStatus>>;
type GoalStatus = ReturnType<typeof goalObserverFor>;
type SessionPage = Awaited<ReturnType<typeof peekSessionPage>>;

export interface NightBuildBridgeDataSource {
  config(): Config;
  connectionStatus(): ConnectionStatus;
  browserStatus(): Promise<BrowserStatus>;
  listSessions(limit: number): Promise<SessionPage>;
  goalStatus(conversationId: string): GoalStatus;
  workers(): SwarmState;
}

const productionSource: NightBuildBridgeDataSource = {
  config: getConfig,
  connectionStatus: getStatus,
  browserStatus: bridgeObserverStatus,
  listSessions: (limit) => peekSessionPage({ limit }),
  goalStatus: goalObserverFor,
  workers: () => swarmState()
};

interface ActiveBridge {
  server: http.Server;
  discovery: NightBuildBridgeDiscovery;
  discoveryPath: string;
}

let active: ActiveBridge | null = null;
let shutdownRequested = false;

function latestTimestamp(values: Array<number | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

function boundedNonnegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function knownTurnOutcome(value: unknown): TurnOutcome | 'unreported' {
  return typeof value === 'string' && (TURN_OUTCOMES as readonly string[]).includes(value)
    ? (value as TurnOutcome)
    : 'unreported';
}

function knownAgentState(value: unknown): AgentState | null {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value)
    ? (value as AgentState)
    : null;
}

function aggregateSessions(
  config: Config,
  page: SessionPage
): NightBuildBridgeStatus['sessions'] {
  const sessions = page.sessions;
  const outcomes = Object.fromEntries(
    [...TURN_OUTCOMES, 'unreported'].map((outcome) => [outcome, 0])
  ) as NightBuildBridgeStatus['sessions']['outcomes'];

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

  for (const summary of sessions) {
    const contextTokens = boundedNonnegativeNumber(summary.contextTokens);
    const estimatedTokens = boundedNonnegativeNumber(summary.estimatedTokens);
    events += boundedNonnegativeNumber(summary.events);
    userMessages += boundedNonnegativeNumber(summary.userMessages);
    toolCalls += boundedNonnegativeNumber(summary.toolCalls);
    errors += boundedNonnegativeNumber(summary.errors);
    toolRejected += boundedNonnegativeNumber(summary.toolRejected);
    processExitNonzero += boundedNonnegativeNumber(summary.processExitNonzero);
    maxEstimatedContextTokens = Math.max(maxEstimatedContextTokens, contextTokens);
    maxEstimatedSessionTokens = Math.max(maxEstimatedSessionTokens, estimatedTokens);
    if (contextTokens >= config.sessions.advisoryTokens) sessionsAtOrAboveAdvisory += 1;
    if (contextTokens >= config.compaction.autoTokens) sessionsAtOrAboveAutoCompaction += 1;
    if (typeof summary.lastHandoffAt === 'number' && Number.isFinite(summary.lastHandoffAt)) {
      sessionsWithHandoff += 1;
    }
    if (summary.lastCommittedResumeHandoffId) sessionsWithCommittedResume += 1;
    outcomes[knownTurnOutcome(summary.lastTurnOutcome)] += 1;
  }

  return {
    listedTotal: page.total,
    observed: sessions.length,
    activeTurns: sessions.filter((summary) => Boolean(summary.activeTurnId)).length,
    lastUpdatedAt: latestTimestamp(sessions.map((summary) => summary.updatedAt)),
    context: {
      maxEstimatedContextTokens,
      maxEstimatedSessionTokens,
      sessionsAtOrAboveAdvisory,
      sessionsAtOrAboveAutoCompaction
    },
    activity: {
      events,
      userMessages,
      toolCalls,
      errors,
      toolRejected,
      processExitNonzero,
      lastToolCallAt: latestTimestamp(sessions.map((summary) => summary.lastToolCallAt)),
      lastAssistantFinalAt: latestTimestamp(sessions.map((summary) => summary.lastAssistantFinalAt)),
      lastTurnEndAt: latestTimestamp(sessions.map((summary) => summary.lastTurnEndAt))
    },
    compaction: {
      sessionsWithHandoff,
      sessionsWithCommittedResume,
      lastHandoffAt: latestTimestamp(sessions.map((summary) => summary.lastHandoffAt))
    },
    outcomes
  };
}

function aggregateGoal(
  source: NightBuildBridgeDataSource,
  config: Config,
  sessions: SessionSummary[]
): NightBuildBridgeStatus['goal'] {
  const seen = new Set<string>();
  const result: NightBuildBridgeStatus['goal'] = {
    enabled: config.goal.enabled,
    configuredMode: config.goal.mode,
    observedSessionCount: 0,
    objectivePresent: 0,
    armed: 0,
    drafts: {
      sending: 0,
      answering: 0,
      ready: 0,
      noReply: 0,
      failed: 0,
      retryableFailed: 0
    }
  };

  for (const summary of sessions) {
    const conversationId = summary.conversationId;
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    const goal = source.goalStatus(conversationId);
    result.observedSessionCount += 1;
    if (goal.objectivePresent) result.objectivePresent += 1;
    if (goal.armed) result.armed += 1;
    if (!goal.draft) continue;
    switch (goal.draft.stage) {
      case 'sending':
        result.drafts.sending += 1;
        break;
      case 'answering':
        result.drafts.answering += 1;
        break;
      case 'ready':
        result.drafts.ready += 1;
        break;
      case 'no-reply':
        result.drafts.noReply += 1;
        break;
      case 'failed':
        result.drafts.failed += 1;
        if (goal.draft.retryable) result.drafts.retryableFailed += 1;
        break;
    }
  }
  return result;
}

function aggregateWorkers(state: SwarmState): NightBuildBridgeStatus['workers'] {
  const stateCounts = Object.fromEntries(
    AGENT_STATES.map((state) => [state, 0])
  ) as Record<AgentState, number>;
  let workerCount = 0;
  let activeWorkers = 0;
  let sleepingWorkers = 0;
  let terminalWorkers = 0;
  let maxEstimatedContextTokens = 0;

  for (const agent of state.agents) {
    const agentState = knownAgentState(agent.state);
    if (agentState) stateCounts[agentState] += 1;
    maxEstimatedContextTokens = Math.max(
      maxEstimatedContextTokens,
      boundedNonnegativeNumber(agent.contextTokens)
    );
    if (agent.role !== 'worker') continue;
    workerCount += 1;
    if (
      agentState === 'invited' ||
      agentState === 'active' ||
      agentState === 'detached' ||
      agentState === 'waking'
    ) {
      activeWorkers += 1;
    } else if (agentState === 'sleeping') {
      sleepingWorkers += 1;
    } else if (agentState === 'finished' || agentState === 'failed') {
      terminalWorkers += 1;
    }
  }

  return {
    enabled: state.enabled,
    running: state.running,
    retainedHistory: state.retainedHistory === true,
    totalAgents: state.agents.length,
    workerCount,
    activeWorkers,
    sleepingWorkers,
    terminalWorkers,
    stateCounts,
    maxEstimatedContextTokens
  };
}

function connectionProjection(status: ConnectionStatus): NightBuildBridgeStatus['connection'] {
  return {
    state: status.state,
    handshakeAt: status.handshakeAt,
    lastRequestAt: status.lastRequestAt,
    lastToolCallAt: status.lastToolCallAt,
    surfaceCount: status.surfaces.length,
    availableSurfaceCount: status.surfaces.filter((surface) => surface.available).length
  };
}

export async function projectNightBuildBridgeStatus(
  source: NightBuildBridgeDataSource,
  discovery: NightBuildBridgeDiscovery
): Promise<NightBuildBridgeStatus> {
  const [browser, page] = await Promise.all([
    source.browserStatus(),
    source.listSessions(OBSERVED_SESSION_LIMIT)
  ]);
  const config = source.config();
  const connection = source.connectionStatus();
  const workers = source.workers();
  return {
    protocolVersion: NIGHT_BUILD_BRIDGE_PROTOCOL,
    appVersion: discovery.appVersion,
    observedAt: Date.now(),
    capabilities: [...CAPABILITIES],
    controller: {
      running: true,
      startedAt: discovery.startedAt
    },
    connection: connectionProjection(connection),
    browserAutomation: {
      running: browser.running,
      paired: browser.paired,
      present: browser.present,
      lastSeenAt: browser.lastSeenAt
    },
    features: {
      recording: config.sessions.record,
      multiAgent: config.multiAgent.enabled,
      goal: config.goal.enabled,
      compactionAuto: config.compaction.auto,
      advisoryTokens: config.sessions.advisoryTokens,
      limitTokens: config.sessions.limitTokens,
      autoCompactionTokens: config.compaction.autoTokens
    },
    sessions: aggregateSessions(config, page),
    goal: aggregateGoal(source, config, page.sessions),
    workers: aggregateWorkers(workers)
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

function authorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  discovery: NightBuildBridgeDiscovery
): boolean {
  if (req.headers.origin !== undefined) {
    writeJson(res, 403, { error: 'browser_origin_forbidden' });
    return false;
  }
  if (!bearerMatches(req.headers.authorization, discovery.token)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  if (req.headers['x-night-build-protocol'] !== String(NIGHT_BUILD_BRIDGE_PROTOCOL)) {
    writeJson(res, 426, {
      error: 'protocol_mismatch',
      supportedProtocol: NIGHT_BUILD_BRIDGE_PROTOCOL
    });
    return false;
  }
  return true;
}

function requestHandler(
  source: NightBuildBridgeDataSource,
  discovery: NightBuildBridgeDiscovery
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'read_only' });
        return;
      }
      if (hasRequestBody(req)) {
        writeJson(res, 400, { error: 'request_body_forbidden' });
        return;
      }
      if (!req.url || req.url.length > MAX_URL_CHARS) {
        writeJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!authorized(req, res, discovery)) return;
      if (req.url !== '/v1/status') {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      writeJson(res, 200, await projectNightBuildBridgeStatus(source, discovery));
    })().catch(() => {
      // This listener is a privacy boundary. Underlying filesystem/store
      // exceptions can contain session IDs or absolute local paths, so bridge
      // logs deliberately expose only a stable bounded failure class.
      logWarn('night build bridge status request failed');
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  };
}

function discoveryPath(userData: string): string {
  return path.join(userData, NIGHT_BUILD_BRIDGE_DISCOVERY_FILE);
}

async function publishDiscovery(
  userData: string,
  discovery: NightBuildBridgeDiscovery
): Promise<string> {
  const target = discoveryPath(userData);
  const temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(discovery) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(temporary, target);
    if (process.platform !== 'win32') await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

export async function startNightBuildBridge(
  userData: string,
  source: NightBuildBridgeDataSource = productionSource
): Promise<NightBuildBridgeDiscovery | null> {
  if (shutdownRequested) return null;
  if (active) return active.discovery;

  // A crash can leave yesterday's token/port behind. Single-instance ownership is already proven
  // before this runs, so absence is the only truthful discovery state until this listener is live.
  await fs.rm(discoveryPath(userData), { force: true }).catch(() => undefined);

  const seed: NightBuildBridgeDiscovery = {
    protocolVersion: NIGHT_BUILD_BRIDGE_PROTOCOL,
    appVersion: APP_VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: Date.now()
  };
  const server = http.createServer({ maxHeaderSize: 8192 }, requestHandler(source, seed));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once('error', failed);
    server.listen(0, HOST, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== HOST) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Night Build bridge did not bind the required loopback address');
  }
  seed.port = address.port;
  const discovery = { ...seed };
  const published = await publishDiscovery(userData, discovery).catch(async (error) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  });
  if (shutdownRequested) {
    await fs.rm(published, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return null;
  }
  active = { server, discovery, discoveryPath: published };
  logInfo('night build bridge started');
  return discovery;
}

async function stopActiveBridge(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  await fs.rm(current.discoveryPath, { force: true }).catch(() => undefined);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const force = setTimeout(() => {
      current.server.closeAllConnections?.();
      finish();
    }, 5_000);
    force.unref?.();
    current.server.close(() => {
      clearTimeout(force);
      finish();
    });
    current.server.closeIdleConnections?.();
  });
  logInfo('night build bridge stopped');
}

export function shutdownNightBuildBridge(): Promise<void> {
  shutdownRequested = true;
  return stopActiveBridge();
}
