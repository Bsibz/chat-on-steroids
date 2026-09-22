import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  projectNightBuildBridgeV2Status,
  startNightBuildBridgeV2,
  type NightBuildBridgeV2DataSource,
  type NightBuildBridgeV2Handle,
  type NightBuildBridgeV2Snapshot
} from '../src/main/night-build-bridge-v2.js';
import { createDurableSidecarSource, readDurableSidecarSnapshot } from '../src/main/night-build-bridge-sidecar-source.js';
import {
  INSTALLED_COS_EXECUTABLE,
  ownerStillCurrent,
  proveInstalledCoSOwner,
  type InstalledCoSOwnerDeps
} from '../src/main/night-build-bridge-owner.js';
import {
  NIGHT_BUILD_BRIDGE_V2_CAPABILITIES,
  NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE,
  NIGHT_BUILD_BRIDGE_V2_PROTOCOL,
  type NightBuildBridgeV2Discovery
} from '../src/shared/night-build-bridge-v2.js';

const roots: string[] = [];
const handles: NightBuildBridgeV2Handle[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-night-build-v2-'));
  roots.push(root);
  return root;
}

function fixtureSnapshot(): NightBuildBridgeV2Snapshot {
  return {
    features: {
      recording: true,
      multiAgent: true,
      goal: true,
      compactionAuto: true,
      advisoryTokens: 400_000,
      limitTokens: 533_333,
      autoCompactionTokens: 400_000
    },
    sessions: {
      total: 2,
      rows: [
        {
          conversationId: 'SECRET_CONVERSATION',
          updatedAt: 900,
          events: 12,
          userMessages: 3,
          toolCalls: 4,
          errors: 3,
          toolRejected: 2,
          processExitNonzero: 1,
          contextTokens: 450_000,
          estimatedTokens: 600_000,
          lastToolCallAt: 800,
          lastAssistantFinalAt: 850,
          lastTurnEndAt: 875,
          lastHandoffAt: 700,
          lastCommittedResumeHandoffId: 'SECRET_HANDOFF',
          lastTurnOutcome: 'completed',
          activeTurnId: 'SECRET_TURN'
        },
        {
          conversationId: null,
          updatedAt: 500,
          events: 2,
          userMessages: 1,
          toolCalls: 1,
          errors: 0,
          toolRejected: 0,
          processExitNonzero: 0,
          contextTokens: 10_000,
          estimatedTokens: 20_000,
          lastToolCallAt: 450,
          lastAssistantFinalAt: null,
          lastTurnEndAt: 475,
          lastHandoffAt: null,
          lastCommittedResumeHandoffId: null,
          lastTurnOutcome: null,
          activeTurnId: null
        }
      ]
    },
    goal: {
      enabled: true,
      mode: 'loop',
      draftsObserved: true,
      rows: [{ enabled: true, mode: 'loop', objectivePresent: true, armed: true, draft: { stage: 'failed', retryable: true } }]
    },
    workers: {
      enabled: true,
      running: true,
      retainedHistory: true,
      rows: [
        { role: 'prime', state: 'active', contextTokens: 100_000 },
        { role: 'worker', state: 'sleeping', contextTokens: 200_000 }
      ]
    }
  };
}

function fixtureSource(mode: 'in-process' | 'durable-sidecar' = 'in-process'): NightBuildBridgeV2DataSource {
  return {
    observationMode: mode,
    controllerStartedAt: 123_000,
    snapshot: async () => fixtureSnapshot()
  };
}

async function request(
  discovery: NightBuildBridgeV2Discovery,
  options: { method?: string; path?: string; token?: string; protocol?: string; origin?: string; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const body = options.body ?? '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: discovery.host,
      port: discovery.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/v2/status',
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.protocol === undefined ? {} : { 'x-night-build-protocol': options.protocol }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function writeFixtureUserData(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'sessions', 'session-0001'), { recursive: true });
  await fs.mkdir(path.join(root, 'sessions', 'session-0002'), { recursive: true });
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    sessions: { record: true, advisoryTokens: 400_000, limitTokens: 533_333 },
    compaction: { auto: true, autoTokens: 400_000 },
    multiAgent: { enabled: true },
    goal: { enabled: false, mode: 'goal' },
    SECRET_CONFIG_PROSE: 'must never leave the sidecar'
  }));
  const session = (id: string, conversationId: string | null, updatedAt: number) => ({
    id,
    title: 'SECRET_SESSION_TITLE',
    conversationId,
    updatedAt,
    events: 10,
    userMessages: 2,
    toolCalls: 3,
    errors: 1,
    toolRejected: 1,
    processExitNonzero: 0,
    contextTokens: 410_000,
    estimatedTokens: 510_000,
    lastToolCallAt: 700,
    lastAssistantFinalAt: 710,
    lastTurnEndAt: 720,
    lastHandoffAt: 650,
    lastCommittedResumeHandoffId: 'SECRET_RESUME_ID',
    lastTurnOutcome: 'completed',
    activeTurnId: null,
    origin: null,
    selectedModel: { model: 'SECRET_MODEL' },
    projectId: 'SECRET_PROJECT'
  });
  await fs.writeFile(path.join(root, 'sessions', 'session-0001', 'meta.json'), JSON.stringify(session('session-0001', 'conversation-0001', 1_000)));
  await fs.writeFile(path.join(root, 'sessions', 'session-0002', 'meta.json'), JSON.stringify(session('session-0002', null, 900)));
  await fs.writeFile(path.join(root, 'state', 'goal-objectives.json'), JSON.stringify({
    version: 1,
    savedAt: 100,
    objectives: [{ conversationId: 'conversation-0001', objective: 'SECRET_OBJECTIVE_PROSE' }]
  }));
  await fs.writeFile(path.join(root, 'state', 'goal-switches.json'), JSON.stringify({
    version: 1,
    savedAt: 100,
    switches: [{ conversationId: 'conversation-0001', enabled: true, mode: 'loop', at: 100 }]
  }));
  await fs.writeFile(path.join(root, 'state', 'swarm.json'), JSON.stringify({
    version: 7,
    savedAt: 100,
    runId: 'SECRET_RUN_ID',
    primeConversationId: 'SECRET_PRIME_CONVERSATION',
    startedAt: 90,
    agents: [],
    activeRuns: [{
      runId: 'SECRET_RUN_ID',
      primeConversationId: 'SECRET_PRIME_CONVERSATION',
      startedAt: 90,
      agents: [
        { info: { role: 'prime', state: 'active', contextTokens: 120_000, id: 'SECRET_PRIME_ID', task: 'SECRET_TASK' }, queue: [] },
        { info: { role: 'worker', state: 'sleeping', contextTokens: 220_000, id: 'SECRET_WORKER_ID', task: 'SECRET_WORKER_TASK' }, queue: [] }
      ]
    }],
    dormantRuns: [{
      primeConversationId: 'SECRET_OLD_PRIME',
      startedAt: 1,
      parkedAt: 2,
      agents: [{ info: { role: 'worker', state: 'finished', contextTokens: 300_000, id: 'SECRET_OLD_WORKER' }, queue: [] }]
    }]
  }));
}

describe('Night Build protocol v2', () => {
  it('keeps the sidecar static import graph outside Electron, browser, MCP and secrets owners', async () => {
    const root = path.resolve(import.meta.dirname, '..', 'src', 'main');
    const source = (await Promise.all([
      'night-build-bridge-sidecar.ts',
      'night-build-bridge-sidecar-source.ts',
      'night-build-bridge-owner.ts',
      'night-build-bridge-v2.ts'
    ].map((name) => fs.readFile(path.join(root, name), 'utf8')))).join('\n');
    expect(source).not.toMatch(/from ['"](?:\.\/)?(?:index|bridge|connection|secrets)(?:\.js)?['"]/);
    expect(source).not.toMatch(/from ['"].*\/mcp\//);
    expect(source).not.toContain("import('./bridge.js')");
    expect(source).not.toContain("import('./connection.js')");
    expect(source).not.toContain("import('./secrets.js')");
  });

  it('projects the exact bounded public schema without browser/MCP/provider/session identity', async () => {
    const discovery: NightBuildBridgeV2Discovery = {
      protocolVersion: 2,
      appVersion: '2.1.14',
      instanceId: 'SECRET_INSTANCE',
      pid: 999,
      host: '127.0.0.1',
      port: 1234,
      token: 'SECRET_BEARER',
      startedAt: 456_000
    };
    const status = await projectNightBuildBridgeV2Status(fixtureSource(), discovery);
    expect(Object.keys(status).sort()).toEqual(['appVersion', 'bridge', 'capabilities', 'controller', 'features', 'goal', 'observedAt', 'protocolVersion', 'sessions', 'workers'].sort());
    expect(status.capabilities).toEqual([...NIGHT_BUILD_BRIDGE_V2_CAPABILITIES]);
    expect(status.bridge).toEqual({ observationMode: 'in-process', startedAt: discovery.startedAt });
    expect(status.controller).toEqual({ running: true, startedAt: 123_000 });
    expect(status.goal).toMatchObject({ enabled: true, mode: 'loop', observedSessionCount: 1, objectivePresent: 1, armed: 1, draftsObserved: true, drafts: { failed: 1, retryableFailed: 1 } });
    expect(status.workers).toMatchObject({ totalAgents: 2, workerCount: 1, sleepingWorkers: 1, retainedHistory: true });
    const encoded = JSON.stringify(status);
    for (const marker of ['SECRET_INSTANCE', 'SECRET_BEARER', 'SECRET_CONVERSATION', 'SECRET_HANDOFF', 'SECRET_TURN']) expect(encoded).not.toContain(marker);
    for (const forbidden of ['connection', 'browserAutomation', 'provider', 'model', 'toolNames', 'path']) expect(encoded).not.toContain(`"${forbidden}"`);
  });

  it('reads durable state directly, accepts installed swarm v7, and marks drafts unobserved', async () => {
    const root = await tempRoot();
    await writeFixtureUserData(root);
    const snapshot = await readDurableSidecarSnapshot(root);
    expect(snapshot.sessions).toMatchObject({ total: 2 });
    expect(snapshot.workers).toMatchObject({ enabled: true, running: true, retainedHistory: true });
    expect(snapshot.workers.rows).toHaveLength(2);
    expect(snapshot.goal).toMatchObject({ enabled: false, mode: 'goal', draftsObserved: false });
    expect(snapshot.goal.rows[0]).toMatchObject({ objectivePresent: true, armed: true, enabled: true, mode: 'loop', draft: null });

    const source = createDurableSidecarSource(root, { startedAt: 123_000 });
    const status = await projectNightBuildBridgeV2Status(source, {
      protocolVersion: 2,
      appVersion: '2.1.14',
      instanceId: 'SECRET_INSTANCE',
      pid: 1000,
      host: '127.0.0.1',
      port: 1,
      token: 'SECRET_TOKEN',
      startedAt: 456_000
    });
    expect(status.bridge).toEqual({ observationMode: 'durable-sidecar', startedAt: 456_000 });
    expect(status.controller.startedAt).toBe(123_000);
    expect(status.goal.draftsObserved).toBe(false);
    expect(status.goal.drafts).toBeNull();
    expect(status.goal.observedSessionCount).toBe(1);
    expect(status.goal.objectivePresent).toBe(1);
    expect(status.goal.armed).toBe(1);
    expect(status.sessions.context.sessionsAtOrAboveAdvisory).toBe(2);
    expect(status.workers.stateCounts.finished).toBe(0);
    const encoded = JSON.stringify(status);
    for (const marker of ['SECRET_', 'conversation-0001']) expect(encoded).not.toContain(marker);
  });

  it('fails closed on corrupt config, session metadata and unsupported swarm versions', async () => {
    const root = await tempRoot();
    await writeFixtureUserData(root);
    await fs.writeFile(path.join(root, 'config.json'), '{bad');
    await expect(readDurableSidecarSnapshot(root)).rejects.toThrow('durable_json_invalid');

    await writeFixtureUserData(root);
    const meta = JSON.parse(await fs.readFile(path.join(root, 'sessions', 'session-0001', 'meta.json'), 'utf8')) as Record<string, unknown>;
    meta['events'] = 'SECRET_CORRUPT';
    await fs.writeFile(path.join(root, 'sessions', 'session-0001', 'meta.json'), JSON.stringify(meta));
    await expect(readDurableSidecarSnapshot(root)).rejects.toThrow('session_events_invalid');

    await writeFixtureUserData(root);
    await fs.writeFile(path.join(root, 'state', 'swarm.json'), JSON.stringify({ version: 5, activeRuns: [], dormantRuns: [] }));
    await expect(readDurableSidecarSnapshot(root)).rejects.toThrow('swarm_version_invalid');
  });

  it('publishes 0600 exclusively and refuses a foreign discovery file', async () => {
    const root = await tempRoot();
    const discoveryFile = path.join(root, NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE);
    await fs.writeFile(discoveryFile, 'FOREIGN\n');
    await expect(startNightBuildBridgeV2(root, fixtureSource())).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(discoveryFile, 'utf8')).toBe('FOREIGN\n');
    await fs.rm(discoveryFile);

    const handle = await startNightBuildBridgeV2(root, fixtureSource(), { ownershipPollMs: 60_000 });
    handles.push(handle);
    const stat = await fs.stat(discoveryFile);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(discoveryFile, 'utf8'))).toEqual(handle.discovery);
  });

  it('leaves foreign discovery bytes untouched and self-stops when ownership changes', async () => {
    const root = await tempRoot();
    const handle = await startNightBuildBridgeV2(root, fixtureSource(), { ownershipPollMs: 60_000 });
    handles.push(handle);
    const file = path.join(root, NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE);
    await fs.writeFile(file, 'FOREIGN_GENERATION\n');
    expect(await handle.checkOwnershipNow()).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('FOREIGN_GENERATION\n');
    await expect(request(handle.discovery, { token: handle.discovery.token, protocol: '2' })).rejects.toBeTruthy();
  });

  it('self-stops and conditionally removes its own discovery when the owner dies', async () => {
    const root = await tempRoot();
    let alive = true;
    const handle = await startNightBuildBridgeV2(root, fixtureSource('durable-sidecar'), {
      ownerIsCurrent: async () => alive,
      ownershipPollMs: 60_000
    });
    handles.push(handle);
    alive = false;
    expect(await handle.checkOwnershipNow()).toBe(false);
    await expect(fs.readFile(path.join(root, NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(request(handle.discovery, { token: handle.discovery.token, protocol: '2' })).rejects.toBeTruthy();
  });

  it('enforces protocol, bearer, method, body and browser-origin fences over HTTP', async () => {
    const root = await tempRoot();
    const handle = await startNightBuildBridgeV2(root, fixtureSource(), { ownershipPollMs: 60_000 });
    handles.push(handle);
    const d = handle.discovery;
    expect((await request(d)).status).toBe(401);
    expect((await request(d, { token: 'wrong', protocol: '2' })).status).toBe(401);
    expect((await request(d, { token: d.token })).status).toBe(426);
    expect((await request(d, { token: d.token, protocol: '999' })).status).toBe(426);
    const browser = await request(d, { token: d.token, protocol: '2', origin: 'https://example.invalid' });
    expect(browser.status).toBe(403);
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(d, { method: 'OPTIONS', token: d.token, protocol: '2' })).status).toBe(405);
    expect((await request(d, { token: d.token, protocol: '2', body: 'x' })).status).toBe(400);
    expect((await request(d, { path: '/v2/sessions', token: d.token, protocol: '2' })).status).toBe(404);
    const ok = await request(d, { token: d.token, protocol: '2' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(ok.text) as Record<string, unknown>;
    expect(body['protocolVersion']).toBe(NIGHT_BUILD_BRIDGE_V2_PROTOCOL);
    expect(body).not.toHaveProperty('connection');
    expect(body).not.toHaveProperty('browserAutomation');
    expect(ok.text).not.toContain(d.token);
    expect(ok.text).not.toContain(d.instanceId);
  });
});

describe('installed CoS owner proof', () => {
  function deps(overrides: Partial<InstalledCoSOwnerDeps> = {}): InstalledCoSOwnerDeps {
    return {
      readLink: async () => 'Host.local-13582',
      readFile: async () => '<key>CFBundleShortVersionString</key>\n<string>2.1.14</string>',
      processInfo: async () => ({ command: INSTALLED_COS_EXECUTABLE, startedAt: 123_000 }),
      ...overrides
    };
  }

  it('binds owner identity to SingletonLock PID, exact installed command, process start and installed version', async () => {
    const owner = await proveInstalledCoSOwner('/tmp/user-data', deps());
    expect(owner).toEqual({ pid: 13582, startedAt: 123_000, appVersion: '2.1.14' });
    expect(await ownerStillCurrent('/tmp/user-data', owner, deps())()).toBe(true);
  });

  it('fails closed on a foreign process or changed process generation', async () => {
    await expect(proveInstalledCoSOwner('/tmp/user-data', deps({ processInfo: async () => ({ command: '/tmp/Chat On Steroids', startedAt: 123_000 }) }))).rejects.toThrow('owner_process_mismatch');
    const owner = await proveInstalledCoSOwner('/tmp/user-data', deps());
    expect(await ownerStillCurrent('/tmp/user-data', owner, deps({ processInfo: async () => ({ command: INSTALLED_COS_EXECUTABLE, startedAt: 124_000 }) }))()).toBe(false);
  });
});
