import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/main/config.js';
import {
  projectNightBuildBridgeStatus,
  shutdownNightBuildBridge,
  startNightBuildBridge,
  type NightBuildBridgeDataSource
} from '../src/main/night-build-bridge.js';
import {
  NIGHT_BUILD_BRIDGE_DISCOVERY_FILE,
  NIGHT_BUILD_BRIDGE_PROTOCOL,
  type NightBuildBridgeDiscovery
} from '../src/shared/night-build-bridge.js';
import type { AgentState, SessionSummary, SwarmState } from '../src/shared/session.js';
import type { ConnectionStatus } from '../src/shared/types.js';

const SECRET_MARKERS = [
  'SECRET_SESSION_ID',
  'SECRET_SESSION_TITLE',
  'SECRET_CONVERSATION',
  'SECRET_CHAT_ID',
  'SECRET_PROJECT',
  'SECRET_MODEL',
  'SECRET_WORKER_ID',
  'SECRET_WORKER_LABEL',
  'SECRET_WORKER_TASK',
  'SECRET_WORKER_CONVERSATION',
  'SECRET_CONNECTION_DETAIL',
  'SECRET_PUBLIC_URL',
  'SECRET_LOCAL_URL',
  'SECRET_SURFACE_DESCRIPTION',
  'SECRET_TOOL_NAME'
];

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'SECRET_SESSION_ID',
    title: 'SECRET_SESSION_TITLE',
    conversationId: 'SECRET_CONVERSATION',
    chatIds: ['SECRET_CHAT_ID'],
    projectId: 'SECRET_PROJECT',
    selectedModel: {
      conversationId: 'SECRET_CONVERSATION',
      model: 'SECRET_MODEL',
      observedAt: 100
    },
    startedAt: 100,
    updatedAt: 900,
    endedAt: null,
    events: 12,
    userMessages: 3,
    toolCalls: 4,
    lastToolCallAt: 800,
    lastAssistantFinalAt: 850,
    lastTurnEndAt: 875,
    processExitNonzero: 1,
    toolRejected: 2,
    toolInternalErrors: 1,
    errors: 3,
    estimatedTokens: 600_000,
    contextTokens: 450_000,
    lastHandoffId: 'SECRET_HANDOFF_ID',
    lastHandoffAt: 700,
    lastCommittedResumeHandoffId: 'SECRET_COMMITTED_HANDOFF_ID',
    lastTurnOutcome: 'completed',
    activeTurnId: 'SECRET_TURN_ID',
    agents: ['SECRET_WORKER_ID'],
    origin: null,
    ...overrides
  };
}

function fixtureSource(): NightBuildBridgeDataSource {
  const config = defaultConfig();
  // This projection counts sessions against the configured local-estimate lines, whatever
  // those lines currently are. Pin them below the fixture's 450k session so the test proves
  // the counting itself rather than depending on the shipped calibration of the day.
  config.sessions.advisoryTokens = 300_000;
  config.compaction.autoTokens = 300_000;
  config.goal.enabled = true;
  config.goal.mode = 'loop';
  config.multiAgent.enabled = true;

  const connection: ConnectionStatus = {
    state: 'connected',
    detail: 'SECRET_CONNECTION_DETAIL',
    publicUrl: 'https://SECRET_PUBLIC_URL.invalid',
    localUrl: 'http://127.0.0.1/SECRET_LOCAL_URL',
    handshakeAt: 111,
    lastRequestAt: 222,
    lastToolCallAt: 333,
    health: {
      pollErrors: 9,
      uptimeSeconds: 10,
      route: 'SECRET_ROUTE',
      probe: 'SECRET_PROBE',
      clientVersion: 'SECRET_CLIENT_VERSION'
    },
    surfaces: [
      {
        id: 'core',
        connectorName: 'SECRET_CONNECTOR_NAME',
        description: 'SECRET_SURFACE_DESCRIPTION',
        cardSummary: 'SECRET_CARD_SUMMARY',
        optional: false,
        available: true,
        localUrl: 'http://127.0.0.1/SECRET_SURFACE_LOCAL_URL',
        publicUrl: 'https://SECRET_SURFACE_PUBLIC_URL.invalid',
        tools: ['SECRET_TOOL_NAME'],
        state: 'live',
        detail: 'SECRET_SURFACE_DETAIL',
        lastRequestAt: 444,
        lastToolCallAt: 555
      }
    ]
  };

  const workers: SwarmState = {
    enabled: true,
    running: true,
    retainedHistory: true,
    agents: [
      {
        id: 'prime',
        role: 'prime',
        label: 'SECRET_PRIME_LABEL',
        task: 'SECRET_PRIME_TASK',
        reasoningEffort: null,
        model: null,
        state: 'active',
        createdAt: 1,
        activatedAt: 2,
        finishedAt: null,
        result: null,
        pending: 0,
        awaitingAck: 0,
        delivered: 0,
        conversationId: 'SECRET_PRIME_CONVERSATION',
        detachedAt: null,
        lastSeenAt: 600,
        revivable: false,
        sleptAt: null,
        contextTokens: 100_000
      },
      {
        id: 'SECRET_WORKER_ID',
        role: 'worker',
        label: 'SECRET_WORKER_LABEL',
        task: 'SECRET_WORKER_TASK',
        reasoningEffort: 'high',
        model: 'SECRET_MODEL',
        state: 'sleeping',
        createdAt: 3,
        activatedAt: 4,
        finishedAt: null,
        result: 'SECRET_WORKER_RESULT',
        pending: 5,
        awaitingAck: 2,
        delivered: 9,
        conversationId: 'SECRET_WORKER_CONVERSATION',
        detachedAt: null,
        lastSeenAt: 650,
        revivable: true,
        sleptAt: 675,
        contextTokens: 200_000
      }
    ]
  };

  const sessions = [
    summary(),
    summary({
      id: 'SECRET_SESSION_ID_2',
      title: 'SECRET_SESSION_TITLE_2',
      conversationId: null,
      chatIds: [],
      projectId: undefined,
      selectedModel: undefined,
      updatedAt: 500,
      events: 2,
      userMessages: 1,
      toolCalls: 1,
      lastToolCallAt: 450,
      lastAssistantFinalAt: null,
      lastTurnEndAt: 475,
      processExitNonzero: 0,
      toolRejected: 0,
      toolInternalErrors: 0,
      errors: 0,
      estimatedTokens: 20_000,
      contextTokens: 10_000,
      lastHandoffId: null,
      lastHandoffAt: null,
      lastCommittedResumeHandoffId: null,
      lastTurnOutcome: null,
      activeTurnId: null,
      agents: []
    })
  ];

  return {
    config: () => config,
    connectionStatus: () => connection,
    browserStatus: async () => ({
      running: true,
      port: 8765,
      paired: true,
      present: true,
      lastSeenAt: 777,
      extensionVersion: '9.8.7'
    }),
    listSessions: async (limit) => ({
      sessions: sessions.slice(0, limit),
      total: sessions.length,
      nextCursor: null
    }),
    goalStatus: () => ({
      enabled: true,
      mode: 'loop',
      own: true,
      afterTurn: true,
      armed: true,
      objectivePresent: true,
      draft: { stage: 'failed', retryable: true }
    }),
    workers: () => workers
  };
}

function request(
  discovery: NightBuildBridgeDiscovery,
  options: {
    method?: string;
    path?: string;
    token?: string;
    protocol?: string;
    origin?: string;
    body?: string;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const body = options.body ?? '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: discovery.host,
        port: discovery.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/v1/status',
        headers: {
          ...(options.token === undefined
            ? {}
            : { authorization: `Bearer ${options.token}` }),
          ...(options.protocol === undefined
            ? {}
            : { 'x-night-build-protocol': options.protocol }),
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Night Build read-only capability bridge', () => {
  let userData = '';
  let discovery: NightBuildBridgeDiscovery;
  const source = fixtureSource();

  beforeAll(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-night-build-bridge-'));
    await fs.writeFile(
      path.join(userData, NIGHT_BUILD_BRIDGE_DISCOVERY_FILE),
      '{"token":"STALE_DISCOVERY_SECRET","port":1}\n',
      { mode: 0o600 }
    );
    const started = await startNightBuildBridge(userData, source);
    if (!started) throw new Error('test bridge unexpectedly refused startup');
    discovery = started;
  });

  afterAll(async () => {
    await shutdownNightBuildBridge();
    if (userData) await fs.rm(userData, { recursive: true, force: true });
  });

  it('publishes a fresh private loopback discovery file', async () => {
    const file = path.join(userData, NIGHT_BUILD_BRIDGE_DISCOVERY_FILE);
    const raw = await fs.readFile(file, 'utf8');
    const onDisk = JSON.parse(raw) as NightBuildBridgeDiscovery;
    expect(onDisk).toEqual(discovery);
    expect(onDisk.host).toBe('127.0.0.1');
    expect(onDisk.protocolVersion).toBe(NIGHT_BUILD_BRIDGE_PROTOCOL);
    expect(onDisk.token).not.toBe('STALE_DISCOVERY_SECRET');
    expect(onDisk.token.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on auth, protocol, browser origins, methods and request bodies', async () => {
    expect((await request(discovery)).status).toBe(401);
    expect(
      (await request(discovery, { token: 'wrong', protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL) }))
        .status
    ).toBe(401);
    expect((await request(discovery, { token: discovery.token })).status).toBe(426);
    expect(
      (
        await request(discovery, {
          token: discovery.token,
          protocol: '999'
        })
      ).status
    ).toBe(426);
    const browser = await request(discovery, {
      token: discovery.token,
      protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL),
      origin: 'https://example.invalid'
    });
    expect(browser.status).toBe(403);
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (
        await request(discovery, {
          method: 'OPTIONS',
          token: discovery.token,
          protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL)
        })
      ).status
    ).toBe(405);
    expect(
      (
        await request(discovery, {
          token: discovery.token,
          protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL),
          body: 'x'
        })
      ).status
    ).toBe(400);
  });

  it('serves only the versioned status route', async () => {
    expect(
      (
        await request(discovery, {
          path: '/v1/sessions',
          token: discovery.token,
          protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL)
        })
      ).status
    ).toBe(404);
    expect(
      (
        await request(discovery, {
          path: '/v1/status?debug=true',
          token: discovery.token,
          protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL)
        })
      ).status
    ).toBe(404);
  });

  it('projects aggregate truth without raw session, worker, tool or transport identity', async () => {
    const projected = await projectNightBuildBridgeStatus(source, discovery);
    expect(projected.connection).toMatchObject({
      state: 'connected',
      handshakeAt: 111,
      lastRequestAt: 222,
      lastToolCallAt: 333,
      surfaceCount: 1,
      availableSurfaceCount: 1
    });
    expect(projected.sessions).toMatchObject({
      listedTotal: 2,
      observed: 2,
      activeTurns: 1,
      lastUpdatedAt: 900,
      context: {
        maxEstimatedContextTokens: 450_000,
        maxEstimatedSessionTokens: 600_000,
        sessionsAtOrAboveAdvisory: 1,
        sessionsAtOrAboveAutoCompaction: 1
      },
      activity: {
        events: 14,
        userMessages: 4,
        toolCalls: 5,
        errors: 3,
        toolRejected: 2,
        processExitNonzero: 1,
        lastToolCallAt: 800,
        lastAssistantFinalAt: 850,
        lastTurnEndAt: 875
      },
      compaction: {
        sessionsWithHandoff: 1,
        sessionsWithCommittedResume: 1,
        lastHandoffAt: 700
      }
    });
    expect(projected.sessions.outcomes.completed).toBe(1);
    expect(projected.sessions.outcomes.unreported).toBe(1);
    expect(projected.goal).toMatchObject({
      enabled: true,
      configuredMode: 'loop',
      observedSessionCount: 1,
      objectivePresent: 1,
      armed: 1,
      drafts: { failed: 1, retryableFailed: 1 }
    });
    expect(projected.workers).toMatchObject({
      enabled: true,
      running: true,
      retainedHistory: true,
      totalAgents: 2,
      workerCount: 1,
      activeWorkers: 0,
      sleepingWorkers: 1,
      terminalWorkers: 0,
      maxEstimatedContextTokens: 200_000
    });

    const encoded = JSON.stringify(projected);
    expect('pid' in projected.controller).toBe(false);
    expect('surfaces' in projected.connection).toBe(false);
    for (const secret of SECRET_MARKERS) expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain('SECRET_WORKER_RESULT');
    expect(encoded).not.toContain('SECRET_ROUTE');
    expect(encoded).not.toContain('SECRET_PROBE');
    expect(encoded).not.toContain(discovery.token);
    expect(encoded).not.toContain(discovery.instanceId);
  });

  it('keeps corrupt session metadata inside the fixed aggregate schema', async () => {
    const corrupt = summary() as SessionSummary & Record<string, unknown>;
    corrupt.events = 'SECRET_CORRUPT_EVENTS' as unknown as number;
    corrupt.errors = 'SECRET_CORRUPT_ERRORS' as unknown as number;
    corrupt.contextTokens = 'SECRET_CORRUPT_CONTEXT' as unknown as number;
    corrupt.estimatedTokens = Number.POSITIVE_INFINITY;
    corrupt.lastTurnOutcome = 'SECRET_CORRUPT_OUTCOME' as unknown as SessionSummary['lastTurnOutcome'];
    corrupt.lastHandoffAt = 'SECRET_CORRUPT_HANDOFF' as unknown as number;
    const corruptSource: NightBuildBridgeDataSource = {
      ...source,
      listSessions: async () => ({ sessions: [corrupt], total: 1, nextCursor: null })
    };

    const projected = await projectNightBuildBridgeStatus(corruptSource, discovery);
    expect(projected.sessions.activity.events).toBe(0);
    expect(projected.sessions.activity.errors).toBe(0);
    expect(projected.sessions.context.maxEstimatedContextTokens).toBe(0);
    expect(projected.sessions.context.maxEstimatedSessionTokens).toBe(0);
    expect(projected.sessions.outcomes.unreported).toBe(1);
    expect(projected.sessions.compaction.sessionsWithHandoff).toBe(0);
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain('SECRET_CORRUPT');
  });

  it('keeps corrupt worker state outside the fixed state-count schema', async () => {
    const corruptedWorkers = source.workers();
    corruptedWorkers.agents[0] = {
      ...corruptedWorkers.agents[0]!,
      state: 'SECRET_CORRUPT_AGENT_STATE' as unknown as AgentState,
      contextTokens: 'SECRET_CORRUPT_AGENT_CONTEXT' as unknown as number
    };
    const corruptSource: NightBuildBridgeDataSource = {
      ...source,
      workers: () => corruptedWorkers
    };

    const projected = await projectNightBuildBridgeStatus(corruptSource, discovery);
    expect(Object.keys(projected.workers.stateCounts).sort()).toEqual(
      ['active', 'detached', 'failed', 'finished', 'invited', 'sleeping', 'waking'].sort()
    );
    expect(projected.workers.maxEstimatedContextTokens).toBe(200_000);
    expect(JSON.stringify(projected)).not.toContain('SECRET_CORRUPT_AGENT');
  });

  it('serves the same privacy-safe projection over authenticated HTTP', async () => {
    const response = await request(discovery, {
      token: discovery.token,
      protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL)
    });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body.protocolVersion).toBe(NIGHT_BUILD_BRIDGE_PROTOCOL);
    for (const secret of SECRET_MARKERS) expect(response.text).not.toContain(secret);
    expect(response.text).not.toContain(discovery.token);
    expect(response.text).not.toContain(discovery.instanceId);
  });

  it('removes discovery and stops admitting requests on shutdown', async () => {
    const file = path.join(userData, NIGHT_BUILD_BRIDGE_DISCOVERY_FILE);
    await shutdownNightBuildBridge();
    await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      request(discovery, {
        token: discovery.token,
        protocol: String(NIGHT_BUILD_BRIDGE_PROTOCOL)
      })
    ).rejects.toBeTruthy();
  });
});
