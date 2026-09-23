import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startNightBuildChatTransportV2,
  type NightBuildChatTransportV2Handle
} from '../src/main/night-build-chat-transport-v2.js';
import type { NightBuildChatTransportV2DataSource } from '../src/main/night-build-chat-transport-v2-source.js';
import {
  NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL_HEADER,
  type NightBuildChatTransportV2Discovery
} from '../src/shared/night-build-chat-transport-v2.js';

const roots: string[] = [];
const handles: NightBuildChatTransportV2Handle[] = [];
const CONVERSATION = 'A'.repeat(43);
const TURN = 'B'.repeat(43);
const USER = 'C'.repeat(43);
const SEND_ID = '11111111-1111-4111-8111-111111111111';
const STOP_ID = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-native-chat-v2-'));
  roots.push(root);
  return root;
}

function dataSource(overrides: Partial<NightBuildChatTransportV2DataSource> = {}): NightBuildChatTransportV2DataSource {
  const base: NightBuildChatTransportV2DataSource = {
    list: async () => [],
    transcript: async () => ({
      conversation: { handle: CONVERSATION, title: 'Fixture', updatedAt: 1 },
      projection: {
        current: true,
        identitySource: 'metadata',
        lowerBoundOrigin: 0,
        observedHighWaterSeq: 0,
        metadataHighWaterSeq: 0
      },
      page: {
        mode: 'recent',
        hasEarlier: false,
        hasMore: false,
        earliestOrigin: null,
        latestRevision: 0
      },
      currentTurn: { state: 'idle' },
      items: []
    }),
    createSend: async (input) => ({
      id: input.id,
      conversation: input.conversation,
      state: 'queued',
      createdAt: 1,
      claimedAt: null,
      receipt: null,
      error: null
    }),
    send: async (id) => id === SEND_ID ? ({
      id,
      conversation: CONVERSATION,
      state: 'nativeAcceptanceProved',
      createdAt: 1,
      claimedAt: 2,
      receipt: { userMessage: USER, turn: TURN, turnOrigin: 3 },
      error: null
    }) : null,
    inspectSend: async (id) => id === SEND_ID ? ({
      id,
      conversation: CONVERSATION,
      state: 'nativeAcceptanceProved',
      createdAt: 1,
      claimedAt: 2,
      receipt: { userMessage: USER, turn: TURN, turnOrigin: 3 },
      error: null
    }) : null,
    createStop: async (input) => ({
      id: input.id,
      sendId: input.sendId,
      conversation: input.conversation,
      state: 'queued',
      error: null
    }),
    stop: async (id) => id === STOP_ID ? ({
      id,
      sendId: SEND_ID,
      conversation: CONVERSATION,
      state: 'stopped',
      error: null
    }) : null
  };
  return { ...base, ...overrides };
}

async function request(
  discovery: NightBuildChatTransportV2Discovery,
  options: {
    method?: string;
    path?: string;
    token?: string;
    protocol?: string;
    origin?: string;
    body?: string;
    transferEncoding?: string;
  } = {}
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const body = options.body ?? '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: discovery.host,
      port: discovery.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/v2/conversations',
      headers: {
        ...(options.token === undefined ? {} : { authorization: 'Bearer ' + options.token }),
        ...(options.protocol === undefined ? {} : { [NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL_HEADER]: options.protocol }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.transferEncoding
          ? { 'transfer-encoding': options.transferEncoding }
          : body ? { 'content-length': Buffer.byteLength(body) } : {})
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
    if (body) req.write(body);
    req.end();
  });
}

const auth = (discovery: NightBuildChatTransportV2Discovery) => ({
  token: discovery.token,
  protocol: '2'
});

describe('Night Build Chat Transport v2 local server', () => {
  it('enforces loopback discovery, bearer, protocol, origin and exact method/body fences', async () => {
    const root = await tempRoot();
    const createSend = vi.fn(dataSource().createSend);
    const handle = await startNightBuildChatTransportV2(root, dataSource({ createSend }), {
      appVersion: '2.1.14',
      startedAt: 123
    });
    handles.push(handle);
    const discovery = handle.discovery;

    expect(discovery.host).toBe('127.0.0.1');
    expect(discovery.capabilities).toEqual(['read', 'send', 'stop']);
    expect((await request(discovery)).status).toBe(401);
    expect((await request(discovery, { token: 'wrong', protocol: '2' })).status).toBe(401);
    expect((await request(discovery, { token: discovery.token })).status).toBe(426);
    expect((await request(discovery, { ...auth(discovery), protocol: '999' })).status).toBe(426);

    const browser = await request(discovery, {
      ...auth(discovery),
      origin: 'https://example.invalid'
    });
    expect(browser.status).toBe(403);
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();

    expect((await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/conversations'
    })).status).toBe(405);
    expect((await request(discovery, {
      ...auth(discovery),
      method: 'GET',
      path: '/v2/send-intents'
    })).status).toBe(405);
    expect((await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/send-intents',
      body: JSON.stringify({ id: SEND_ID, conversation: CONVERSATION, text: 'hello', extra: true })
    })).status).toBe(400);
    expect(createSend).not.toHaveBeenCalled();
    expect((await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/send-intents',
      body: JSON.stringify({ id: SEND_ID, conversation: CONVERSATION, text: 'hello' }),
      transferEncoding: 'chunked'
    })).status).toBe(400);
    expect(createSend).not.toHaveBeenCalled();
    expect((await request(discovery, {
      ...auth(discovery),
      path: '/v2/not-a-route'
    })).status).toBe(404);

    const file = path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('serves only typed Send/inspect/Stop routes without leaking transport secrets', async () => {
    const root = await tempRoot();
    const createSend = vi.fn(dataSource().createSend);
    const createStop = vi.fn(dataSource().createStop);
    const handle = await startNightBuildChatTransportV2(root, dataSource({ createSend, createStop }), {
      appVersion: '2.1.14'
    });
    handles.push(handle);
    const discovery = handle.discovery;

    const sendBody = { id: SEND_ID, conversation: CONVERSATION, text: 'exact authored text' };
    const created = await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/send-intents',
      body: JSON.stringify(sendBody)
    });
    expect(created.status).toBe(202);
    expect(createSend).toHaveBeenCalledWith(sendBody);
    expect(created.text).not.toContain(discovery.token);
    expect(created.text).not.toContain(discovery.instanceId);

    expect((await request(discovery, {
      ...auth(discovery),
      path: '/v2/send-intents/' + SEND_ID
    })).status).toBe(200);
    expect((await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/send-intents/' + SEND_ID + '/inspect'
    })).status).toBe(200);

    const stopBody = {
      id: STOP_ID,
      sendId: SEND_ID,
      conversation: CONVERSATION,
      turn: TURN,
      userMessage: USER
    };
    const stopped = await request(discovery, {
      ...auth(discovery),
      method: 'POST',
      path: '/v2/stop-intents',
      body: JSON.stringify(stopBody)
    });
    expect(stopped.status).toBe(202);
    expect(createStop).toHaveBeenCalledWith(stopBody);
    expect((await request(discovery, {
      ...auth(discovery),
      path: '/v2/stop-intents/' + STOP_ID
    })).status).toBe(200);
  });

  it('revokes the stale generation when discovery bytes are replaced and preserves the foreign owner', async () => {
    const root = await tempRoot();
    const handle = await startNightBuildChatTransportV2(root, dataSource());
    handles.push(handle);
    const file = path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE);
    const foreign = JSON.stringify({ foreign: true }) + '\n';
    await fs.writeFile(file, foreign);

    expect((await request(handle.discovery, auth(handle.discovery))).status).toBe(503);
    expect(await handle.checkOwnershipNow()).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(foreign);
  });

  it('does not resolve stop() until an already-admitted mutating request has drained', async () => {
    const root = await tempRoot();
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const source = dataSource({
      createSend: async (input) => {
        started();
        await mayFinish;
        return {
          id: input.id,
          conversation: input.conversation,
          state: 'queued',
          createdAt: 1,
          claimedAt: null,
          receipt: null,
          error: null
        };
      }
    });
    const handle = await startNightBuildChatTransportV2(root, source);
    handles.push(handle);
    const pending = request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: '/v2/send-intents',
      body: JSON.stringify({ id: SEND_ID, conversation: CONVERSATION, text: 'drain me' })
    }).catch(() => null);
    await didStart;
    const stopping = handle.stop();
    const early = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25))
    ]);
    expect(early).toBe(false);
    release();
    await stopping;
    await pending;
  });

  it('reclaims only a discovery generation whose recorded process is provably dead', async () => {
    const root = await tempRoot();
    const file = path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE);
    const deadPid = 424_242;
    await fs.writeFile(file, JSON.stringify({
      protocolVersion: 2,
      appVersion: 'old',
      instanceId: '33333333-3333-4333-8333-333333333333',
      pid: deadPid,
      host: '127.0.0.1',
      port: 1,
      token: 'old',
      startedAt: 1,
      capabilities: ['read', 'send', 'stop']
    }) + '\n', { mode: 0o600 });
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === deadPid) {
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    const handle = await startNightBuildChatTransportV2(root, dataSource());
    handles.push(handle);
    const published = JSON.parse(await fs.readFile(file, 'utf8')) as NightBuildChatTransportV2Discovery;
    expect(published.instanceId).toBe(handle.discovery.instanceId);
    expect(published.token).toBe(handle.discovery.token);
  });

  it('never steals discovery from a process that is still alive', async () => {
    const root = await tempRoot();
    const first = await startNightBuildChatTransportV2(root, dataSource());
    handles.push(first);
    await expect(startNightBuildChatTransportV2(root, dataSource())).rejects.toMatchObject({ code: 'EEXIST' });
    const persisted = JSON.parse(
      await fs.readFile(path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE), 'utf8')
    ) as NightBuildChatTransportV2Discovery;
    expect(persisted.instanceId).toBe(first.discovery.instanceId);
  });
});
