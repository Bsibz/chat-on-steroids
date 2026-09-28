/**
 * Cross-app owner control: Night Build's controls for automatic compaction, Off/Goal/Loop,
 * manual Compact & Resume and cancelling an in-flight compaction.
 *
 * Two seams are pinned separately:
 *  · the loopback generation itself — discovery/auth/protocol/body fences and error mapping,
 *    driven with a fake data source so no product state is invented;
 *  · the in-process owners — real config, Goal/Loop ledger, session store and continuation
 *    transaction, with only the browser/opener side left inert.
 *
 * Frozen v3 is asserted in the same file: the installed 0.1.67 client reads its exact
 * capability set and discovery file, so those literals are a compatibility contract now.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NightBuildChatOwnerControlV1DataSource } from '../src/main/night-build-chat-owner-control-v1-source.js';
import type { NightBuildChatOwnerControlV1Handle } from '../src/main/night-build-chat-owner-control-v1.js';
import type {
  NightBuildChatOwnerStateV1
} from '../src/shared/night-build-chat-owner-control-v1.js';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const {
  createSession,
  initSessionStore,
  observeSessionModel,
  rebindSession,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const { resetGoalStateForTests } = await import('../src/main/goal.js');
const { bindConversation, resetAgentsForTests, spawn } = await import('../src/main/agents.js');
const { resetBlockedChatsForTests, setChatBlocked } = await import('../src/main/session/blocked-chats.js');
const { resetBridgeForTests } = await import('../src/main/bridge.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const {
  attachSummary,
  commitContinuationResult,
  continuationForSession
} = await import('../src/main/session/continuation.js');
const { nightBuildChatHandleForIdentity } = await import('../src/main/night-build-chat-transport-source.js');
const { createInProcessNightBuildChatOwnerControlV1Source } = await import(
  '../src/main/night-build-chat-owner-control-v1-source.js'
);
const {
  startNightBuildChatOwnerControlV1
} = await import('../src/main/night-build-chat-owner-control-v1.js');
const {
  NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES,
  NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL,
  NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER
} = await import('../src/shared/night-build-chat-control-v3.js');
const {
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES,
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER
} = await import('../src/shared/night-build-chat-owner-control-v1.js');
const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('./helpers.js');

const CONVERSATION = 'A'.repeat(43);
const SHARED_INSTANCE = '33333333-3333-4333-8333-333333333333';
const SALT = 'owner-control-test-salt';

const roots: string[] = [];
const handles: NightBuildChatOwnerControlV1Handle[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-owner-control-'));
  roots.push(root);
  return root;
}

function bareState(overrides: Partial<Omit<NightBuildChatOwnerStateV1, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>> = {}) {
  return {
    conversation: CONVERSATION,
    autoCompaction: { configured: false, effective: false, exemption: null, triggerTokens: 750_000 },
    mode: 'off' as const,
    blocked: null,
    compaction: {
      active: false,
      state: 'none' as const,
      automatic: false,
      phase: null,
      startedAt: null,
      cancelAvailable: false,
      startAvailable: true,
      error: null
    },
    ...overrides
  };
}

function dataSource(overrides: Partial<NightBuildChatOwnerControlV1DataSource> = {}): NightBuildChatOwnerControlV1DataSource {
  const base: NightBuildChatOwnerControlV1DataSource = {
    state: async () => bareState(),
    setAutoCompaction: async (_conversation, enabled) => ({
      ...bareState({ autoCompaction: { configured: enabled, effective: enabled, exemption: null, triggerTokens: 750_000 } }),
      cancelledAutomatic: enabled ? 0 : 2
    }),
    setMode: async (_conversation, mode) => bareState({ mode }),
    compact: async () => bareState({
      compaction: {
        active: true,
        state: 'awaiting-summary',
        automatic: false,
        phase: 'asking',
        startedAt: 41,
        cancelAvailable: true,
        startAvailable: false,
        error: null
      }
    }),
    cancelCompaction: async () => ({ ...bareState(), cancelled: true })
  };
  return { ...base, ...overrides };
}

async function request(
  discovery: { host: string; port: number; token: string },
  options: {
    method?: string;
    path?: string;
    token?: string;
    protocol?: string;
    origin?: string;
    body?: string | Buffer;
    transferEncoding?: string;
  } = {}
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const body = options.body ?? '';
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: discovery.host,
      port: discovery.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/owner/state?conversation=' + CONVERSATION,
      headers: {
        ...(options.token === undefined ? {} : { authorization: 'Bearer ' + options.token }),
        ...(options.protocol === undefined ? {} : { [NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER]: options.protocol }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.transferEncoding
          ? { 'transfer-encoding': options.transferEncoding }
          : bytes.length ? { 'content-length': bytes.length } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    if (bytes.length) req.write(bytes);
    req.end();
  });
}

const auth = (discovery: { token: string }) => ({ token: discovery.token, protocol: '1' });

describe('Night Build Chat owner control v1 loopback server', () => {
  it('publishes a distinct fail-closed owner generation and freezes v3 compatibility', async () => {
    // The installed 0.1.67 client reads v3's exact strings. These are literal contracts now.
    expect(NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE).toBe('night-build-chat-control-v3.json');
    expect(NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL).toBe(3);
    expect(NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER).toBe('x-night-build-chat-protocol');
    expect(NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES).toEqual([
      'state', 'model-catalog', 'attachment-stage', 'configured-send', 'fresh-send', 'cancel-send'
    ]);
    expect(NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE).toBe('night-build-chat-owner-control-v1.json');
    expect(NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER).toBe('x-night-build-chat-owner-control-protocol');
    expect(NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES).toEqual([
      'owner-state', 'auto-compaction-set', 'conversation-mode-set', 'compact-resume', 'compact-cancel'
    ]);

    const root = await tempRoot();
    const handle = await startNightBuildChatOwnerControlV1(root, dataSource(), {
      appVersion: '2.1.43',
      startedAt: 123,
      instanceId: SHARED_INSTANCE
    });
    handles.push(handle);
    const discovery = handle.discovery;

    expect(discovery.host).toBe('127.0.0.1');
    expect(discovery.protocolVersion).toBe(1);
    expect(discovery.instanceId).toBe(SHARED_INSTANCE);
    expect(discovery.startedAt).toBe(123);
    expect((await request(discovery)).status).toBe(401);
    expect((await request(discovery, { token: discovery.token })).status).toBe(426);
    expect((await request(discovery, { ...auth(discovery), origin: 'https://example.invalid' })).status).toBe(403);
    expect((await request(discovery, { ...auth(discovery), protocol: '3' })).status).toBe(426);

    const file = path.join(root, NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(request(discovery, auth(discovery))).rejects.toBeTruthy();
  });

  it('rejects an invalid shared owner generation before publishing discovery', async () => {
    const root = await tempRoot();
    await expect(startNightBuildChatOwnerControlV1(root, dataSource(), { instanceId: 'not-a-generation' }))
      .rejects.toThrow('instance id is invalid');
    await expect(fs.stat(path.join(root, NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects one opaque conversation with common envelope fields and no token echo', async () => {
    const root = await tempRoot();
    const state = vi.fn(dataSource().state);
    const handle = await startNightBuildChatOwnerControlV1(root, dataSource({ state }), {
      appVersion: '2.1.43',
      startedAt: 456
    });
    handles.push(handle);
    const response = await request(handle.discovery, auth(handle.discovery));
    expect(response.status).toBe(200);
    expect(state).toHaveBeenCalledWith(CONVERSATION);
    const body = JSON.parse(response.text);
    expect(body).toMatchObject({
      protocolVersion: 1,
      appVersion: '2.1.43',
      transportStartedAt: 456,
      conversation: CONVERSATION,
      autoCompaction: { configured: false, effective: false, exemption: null, triggerTokens: 750_000 },
      mode: 'off',
      blocked: null,
      compaction: { active: false, state: 'none', cancelAvailable: false, startAvailable: true }
    });
    expect(body.observedAt).toBeTypeOf('number');
    expect(response.text).not.toContain(handle.discovery.token);
  });

  it('routes each mutation to its owner and returns the fresh projection', async () => {
    const root = await tempRoot();
    const source = dataSource();
    const setAutoCompaction = vi.fn(source.setAutoCompaction);
    const setMode = vi.fn(source.setMode);
    const compact = vi.fn(source.compact);
    const cancelCompaction = vi.fn(source.cancelCompaction);
    const handle = await startNightBuildChatOwnerControlV1(root, dataSource({
      setAutoCompaction, setMode, compact, cancelCompaction
    }));
    handles.push(handle);

    const auto = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/auto-compaction`,
      body: JSON.stringify({ enabled: false })
    });
    expect(auto.status).toBe(200);
    expect(setAutoCompaction).toHaveBeenCalledWith(CONVERSATION, false);
    expect(JSON.parse(auto.text)).toMatchObject({ cancelledAutomatic: 2 });

    const mode = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/mode`,
      body: JSON.stringify({ mode: 'loop' })
    });
    expect(mode.status).toBe(200);
    expect(setMode).toHaveBeenCalledWith(CONVERSATION, 'loop');
    expect(JSON.parse(mode.text).mode).toBe('loop');

    const start = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/compaction`
    });
    expect(start.status).toBe(202);
    expect(compact).toHaveBeenCalledWith(CONVERSATION);
    expect(JSON.parse(start.text).compaction).toMatchObject({ active: true, state: 'awaiting-summary', phase: 'asking' });

    const cancel = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/compaction/cancel`
    });
    expect(cancel.status).toBe(200);
    expect(cancelCompaction).toHaveBeenCalledWith(CONVERSATION);
    expect(JSON.parse(cancel.text).cancelled).toBe(true);
  });

  it.each([
    ['native_chat_conversation_unavailable', 404, 'conversation_unavailable'],
    ['native_chat_conversation_changed', 409, 'conversation_changed'],
    ['conversation_superseded', 409, 'conversation_superseded'],
    ['native_chat_mutation_pending', 409, 'conversation_busy'],
    ['worker_compaction_disabled', 409, 'worker_compaction_disabled'],
    ['worker_goal_disabled', 409, 'worker_goal_disabled'],
    ['chat_blocked', 409, 'chat_blocked'],
    ['native_chat_browser_unavailable', 503, 'browser_unavailable']
  ])('maps owner refusal %s to %i %s', async (message, status, code) => {
    const root = await tempRoot();
    const handle = await startNightBuildChatOwnerControlV1(root, dataSource({
      state: async () => { throw new Error(message); }
    }));
    handles.push(handle);
    const response = await request(handle.discovery, auth(handle.discovery));
    expect(response.status).toBe(status);
    expect(JSON.parse(response.text)).toEqual({ error: code });
  });

  it('rejects malformed bodies, methods, queries and unknown routes', async () => {
    const root = await tempRoot();
    const source = dataSource();
    const setMode = vi.fn(source.setMode);
    const setAutoCompaction = vi.fn(source.setAutoCompaction);
    const compact = vi.fn(source.compact);
    const handle = await startNightBuildChatOwnerControlV1(root, dataSource({ setMode, setAutoCompaction, compact }));
    handles.push(handle);
    const authed = auth(handle.discovery);
    const post = (suffix: string, body?: string | Buffer, extra: Record<string, unknown> = {}) => request(handle.discovery, {
      ...authed,
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/${suffix}`,
      ...(body === undefined ? {} : { body }),
      ...extra
    });

    expect((await request(handle.discovery, {
      ...authed,
      path: `/owner/state?conversation=${CONVERSATION}&extra=1`
    })).status).toBe(400);
    expect((await request(handle.discovery, { ...authed, path: '/owner/state' })).status).toBe(400);
    expect((await request(handle.discovery, { ...authed, path: '/owner/nope' })).status).toBe(404);
    expect((await request(handle.discovery, { ...authed, method: 'GET', path: `/owner/conversations/${CONVERSATION}/mode` })).status)
      .toBe(405);
    expect((await post('mode', JSON.stringify({ mode: 'bogus' }))).status).toBe(400);
    expect((await post('mode', JSON.stringify({ mode: 'off', extra: true }))).status).toBe(400);
    expect((await post('mode', 'not json')).status).toBe(400);
    expect((await post('auto-compaction', JSON.stringify({ enabled: 'yes' }))).status).toBe(400);
    expect((await post('auto-compaction', JSON.stringify({}))).status).toBe(400);
    expect((await post('mode', undefined, { transferEncoding: 'chunked' })).status).toBe(400);
    expect((await post('compaction', JSON.stringify({}))).status).toBe(400);
    expect((await post('compaction/cancel', 'x')).status).toBe(400);
    expect((await request(handle.discovery, {
      ...authed,
      method: 'POST',
      path: `/owner/conversations/${CONVERSATION}/mode?x=1`,
      body: JSON.stringify({ mode: 'off' })
    })).status).toBe(400);
    expect(setMode).not.toHaveBeenCalled();
    expect(setAutoCompaction).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
  });
});

describe('Night Build Chat owner control v1 in-process owners', () => {
  let dir: string;
  let fixtureSeq = 0;

  /** A fresh conversation id per fixture: the disk catalog is shared across these tests. */
  function chatId(tag: string): string {
    fixtureSeq += 1;
    return `owner-${tag}-${fixtureSeq}`;
  }

  beforeAll(async () => {
    dir = await makeTempDir('clf-owner-control-');
    initConfigPath(dir);
    initSecretsPath(dir);
    initSessionStore(dir);
    initDurableStore(dir);
  });

  afterAll(async () => {
    await removeTempDir(dir);
  });

  beforeEach(async () => {
    resetDurableForTests();
    initDurableStore(dir);
    resetSessionStoreForTests();
    resetBridgeForTests();
    resetGoalStateForTests();
    resetAgentsForTests();
    resetBlockedChatsForTests();
    resetRecorderForTests();
    const config = defaultConfig();
    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 3 },
      // Keep the browser side inert; these tests own the CoS mutation owners, not opening.
      ui: { ...config.ui, browserOnly: true }
    });
  });

  async function ownerSession(conversationId: string): Promise<{ sessionId: string; handle: string }> {
    const session = await createSession({ conversationId });
    const handle = await nightBuildChatHandleForIdentity(dir, SALT, session.id, conversationId);
    if (!handle) throw new Error('fixture handle did not resolve');
    return { sessionId: session.id, handle };
  }

  const ownerSource = () => createInProcessNightBuildChatOwnerControlV1Source(dir, SALT);

  it('distinguishes configured global auto-compaction from the effective per-chat answer', async () => {
    const conversationId = chatId('auto');
    const { sessionId, handle } = await ownerSession(conversationId);
    const source = ownerSource();

    expect((await source.state(handle)).autoCompaction).toEqual({
      configured: false, effective: false, exemption: null, triggerTokens: 750_000
    });

    const enabled = await source.setAutoCompaction(handle, true);
    expect(enabled.cancelledAutomatic).toBe(0);
    expect(enabled.autoCompaction).toEqual({
      configured: true, effective: true, exemption: null, triggerTokens: 750_000
    });

    // The exact-Pro exemption is per selected model/conversation, not a global claim.
    await observeSessionModel(sessionId, conversationId, 'gpt-6-pro', Date.now(), 'pro');
    expect((await source.state(handle)).autoCompaction).toEqual({
      configured: true, effective: false, exemption: 'pro', triggerTokens: 750_000
    });

    const disabled = await source.setAutoCompaction(handle, false);
    expect(disabled.autoCompaction).toEqual({
      configured: false, effective: false, exemption: null, triggerTokens: 750_000
    });
  });

  it('sets Off/Goal/Loop through the existing per-chat Goal/Loop owner', async () => {
    const { handle } = await ownerSession(chatId('mode'));
    const source = ownerSource();

    expect((await source.setMode(handle, 'loop')).mode).toBe('loop');
    expect((await source.setMode(handle, 'goal')).mode).toBe('goal');
    expect((await source.setMode(handle, 'off')).mode).toBe('off');
    expect((await source.state(handle)).mode).toBe('off');
    // The preference is not erased by Off: the next deliberate switch decides again.
    expect((await source.setMode(handle, 'goal')).mode).toBe('goal');
  });

  it('starts and cancels a manual Compact & Resume through the one durable transaction', async () => {
    const { sessionId, handle } = await ownerSession(chatId('compact'));
    const source = ownerSource();

    const started = await source.compact(handle);
    expect(started.compaction).toMatchObject({
      active: true,
      state: 'awaiting-summary',
      automatic: false,
      phase: 'asking',
      cancelAvailable: true,
      startAvailable: false
    });
    const token = continuationForSession(sessionId)?.token;
    expect(token).toBeTypeOf('string');

    // Pressing again is the one transaction, not a second replacement chat.
    const again = await source.compact(handle);
    expect(again.compaction.active).toBe(true);
    expect(continuationForSession(sessionId)?.token).toBe(token);

    const cancelled = await source.cancelCompaction(handle);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.compaction).toMatchObject({
      active: false,
      state: 'none',
      cancelAvailable: false,
      startAvailable: true
    });
    expect(continuationForSession(sessionId)).toBeNull();
  });

  it('reports cancelled:false and no availability when the commit crossed the abort boundary', async () => {
    const conversationId = chatId('race');
    const { sessionId, handle } = await ownerSession(conversationId);
    // UUID-like so the commit takes the same owned-destination check a real chat does.
    const destination = randomUUID();
    const source = ownerSource();
    await source.compact(handle);
    const token = continuationForSession(sessionId)!.token;
    expect(await attachSummary(token, SAMPLE_BRIEF)).not.toBeNull();
    expect(continuationForSession(sessionId)?.state).toBe('awaiting-chat');

    // Hold the commit after the durable `committing` transition published, so the cancel
    // arrives on exactly the wrong side of the abort boundary.
    const store = await import('../src/main/session/store.js');
    const originalFind = store.findSessionByConversation;
    let reached!: () => void;
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(store, 'findSessionByConversation').mockImplementation(async (conversation, options) => {
      reached();
      await gate;
      return originalFind(conversation, options);
    });
    const commit = commitContinuationResult(token, destination);
    await atCommit;
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    const cancelled = await source.cancelCompaction(handle);
    expect(cancelled.cancelled).toBe(false);
    expect(cancelled.compaction.state).toBe('committing');
    expect(cancelled.compaction.cancelAvailable).toBe(false);
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    release();
    await commit;
    spy.mockRestore();

    // After the move the old handle is refused rather than projected as the new chat.
    await expect(source.state(handle)).rejects.toThrow('native_chat_conversation_unavailable');
    const moved = await nightBuildChatHandleForIdentity(dir, SALT, sessionId, destination);
    expect(moved).toBeTypeOf('string');
    expect((await source.state(moved!)).compaction.state).toBe('none');
  });

  it('refuses worker and blocked chats while keeping Off and cancel paths open', async () => {
    const workerChat = chatId('worker');
    const worker = await ownerSession(workerChat);
    const workerSpawn = spawn({ workers: [{ task: 'hold the slot' }], caller: { conversationId: chatId('prime') } });
    expect(bindConversation(workerSpawn.created[0]!.id, workerChat)).toBe(true);
    const source = ownerSource();

    const workerState = await source.state(worker.handle);
    expect(workerState).toMatchObject({ blocked: 'worker', mode: 'off' });
    expect(workerState.compaction.startAvailable).toBe(false);
    await expect(source.setMode(worker.handle, 'loop')).rejects.toThrow('worker_goal_disabled');
    await expect(source.compact(worker.handle)).rejects.toThrow('worker_compaction_disabled');
    await expect(source.setAutoCompaction(worker.handle, true)).rejects.toThrow('worker_compaction_disabled');
    await expect(source.setAutoCompaction(worker.handle, false)).rejects.toThrow('worker_compaction_disabled');
    expect((await source.setMode(worker.handle, 'off')).mode).toBe('off');

    const blockedChat = chatId('blocked');
    const blocked = await ownerSession(blockedChat);
    setChatBlocked(blockedChat, true);
    const blockedState = await source.state(blocked.handle);
    expect(blockedState).toMatchObject({ blocked: 'blocked', mode: 'off' });
    await expect(source.setMode(blocked.handle, 'goal')).rejects.toThrow('chat_blocked');
    await expect(source.compact(blocked.handle)).rejects.toThrow('chat_blocked');
    await expect(source.setAutoCompaction(blocked.handle, true)).rejects.toThrow('chat_blocked');
    // Turning the app-wide switch off is still the user's to do.
    expect((await source.setAutoCompaction(blocked.handle, false)).autoCompaction.configured).toBe(false);
    expect((await source.setMode(blocked.handle, 'off')).mode).toBe('off');
  });

  it('fails closed for stale and superseded conversation handles', async () => {
    const staleChat = chatId('stale');
    const movedChat = chatId('stale-moved');
    const stale = await ownerSession(staleChat);
    const source = ownerSource();
    expect(await rebindSession(stale.sessionId, staleChat, movedChat)).toBe(true);

    await expect(source.state(stale.handle)).rejects.toThrow('native_chat_conversation_unavailable');
    await expect(source.setMode(stale.handle, 'off')).rejects.toThrow('native_chat_conversation_unavailable');
    await expect(source.compact(stale.handle)).rejects.toThrow('native_chat_conversation_unavailable');
    await expect(source.cancelCompaction(stale.handle)).rejects.toThrow('native_chat_conversation_unavailable');
    const moved = await nightBuildChatHandleForIdentity(dir, SALT, stale.sessionId, movedChat);
    expect(moved).toBeTypeOf('string');

    // A superseded source chat opened again must not regain owner authority.
    const supersededChat = chatId('superseded');
    const supersededSource = await ownerSession(supersededChat);
    expect(await rebindSession(supersededSource.sessionId, supersededChat, chatId('superseded-moved'))).toBe(true);
    const reopened = await createSession({ conversationId: supersededChat });
    const reopenedHandle = await nightBuildChatHandleForIdentity(dir, SALT, reopened.id, supersededChat);
    expect(reopenedHandle).toBeTypeOf('string');
    await expect(source.state(reopenedHandle!)).rejects.toThrow('native_chat_conversation_unavailable');
  });

  it('serves the real owner state over loopback without a provider-context claim', async () => {
    const { handle } = await ownerSession(chatId('http'));
    const server = await startNightBuildChatOwnerControlV1(
      dir,
      createInProcessNightBuildChatOwnerControlV1Source(dir, SALT),
      { appVersion: '2.1.43', startedAt: 99, instanceId: SHARED_INSTANCE }
    );
    handles.push(server);
    const authed = auth(server.discovery);

    const state = await request(server.discovery, {
      ...authed,
      path: '/owner/state?conversation=' + handle
    });
    expect(state.status).toBe(200);
    const body = JSON.parse(state.text);
    expect(body.conversation).toBe(handle);
    expect(body.autoCompaction).toEqual({ configured: false, effective: false, exemption: null, triggerTokens: 750_000 });
    expect(body.mode).toBe('off');
    expect(body.compaction.state).toBe('none');
    // The local recorder trigger is a local unit; the wire carries no occupancy claim.
    expect(Object.keys(body.autoCompaction).sort()).toEqual(['configured', 'effective', 'exemption', 'triggerTokens']);
    expect(state.text).not.toMatch(/occupancy|estimatedTokens|contextTokens|providerContext/i);

    const mode = await request(server.discovery, {
      ...authed,
      method: 'POST',
      path: `/owner/conversations/${handle}/mode`,
      body: JSON.stringify({ mode: 'loop' })
    });
    expect(mode.status).toBe(200);
    expect(JSON.parse(mode.text).mode).toBe('loop');

    const compact = await request(server.discovery, {
      ...authed,
      method: 'POST',
      path: `/owner/conversations/${handle}/compaction`
    });
    expect(compact.status).toBe(202);
    expect(JSON.parse(compact.text).compaction).toMatchObject({ active: true, state: 'awaiting-summary' });

    const cancel = await request(server.discovery, {
      ...authed,
      method: 'POST',
      path: `/owner/conversations/${handle}/compaction/cancel`
    });
    expect(cancel.status).toBe(200);
    expect(JSON.parse(cancel.text)).toMatchObject({ cancelled: true, compaction: { active: false, state: 'none' } });
  });
});
