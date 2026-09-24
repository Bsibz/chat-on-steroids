import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startNightBuildChatControlV3,
  type NightBuildChatControlV3Handle
} from '../src/main/night-build-chat-control-v3.js';
import type { NightBuildChatControlV3DataSource } from '../src/main/night-build-chat-control-v3-source.js';
import {
  NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER,
  type NightBuildChatControlV3Discovery
} from '../src/shared/night-build-chat-control-v3.js';

const roots: string[] = [];
const handles: NightBuildChatControlV3Handle[] = [];
const CONVERSATION = 'A'.repeat(43);
const SEND_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-native-chat-v3-'));
  roots.push(root);
  return root;
}

function dataSource(overrides: Partial<NightBuildChatControlV3DataSource> = {}): NightBuildChatControlV3DataSource {
  const base: NightBuildChatControlV3DataSource = {
    state: async (conversation) => ({
      conversation,
      selectedModel: { model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: 11 },
      activeTurn: { turnOrigin: 42, startedAt: 9 },
      plan: {
        explanation: 'Keep the daily driver moving.',
        plan: [
          { step: 'Fix transcript activity', status: 'in_progress', details: 'Keep tools inline with prose.' },
          { step: 'Dogfood the candidate', status: 'pending' }
        ],
        updatedAt: 12
      },
      modelCatalog: {
        state: 'ready',
        requestedAt: null,
        observedAt: 10,
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] }]
      },
      context: {
        estimatedTokens: 113_646,
        configuredLimit: 533_333,
        configuredWarning: 400_000,
        autoCompaction: true,
        autoCompactionAt: 400_000
      }
    }),
    refreshModels: async () => undefined,
    stageAttachment: async (name, bytes) => ({
      id: ATTACHMENT_ID,
      name,
      size: bytes.byteLength,
      mimeType: 'image/png'
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
    send: async () => null,
    inspectSend: async () => null,
    createFreshSend: async (input) => ({
      id: input.id,
      destinationConversation: null,
      state: 'queued',
      createdAt: 1,
      claimedAt: null,
      receipt: null,
      error: null
    }),
    freshSend: async () => null,
    inspectFreshSend: async () => null
  };
  return { ...base, ...overrides };
}

async function request(
  discovery: NightBuildChatControlV3Discovery,
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
      path: options.path ?? '/v3/state?conversation=' + CONVERSATION,
      headers: {
        ...(options.token === undefined ? {} : { authorization: 'Bearer ' + options.token }),
        ...(options.protocol === undefined ? {} : { [NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER]: options.protocol }),
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

const auth = (discovery: NightBuildChatControlV3Discovery) => ({
  token: discovery.token,
  protocol: '3'
});

describe('Night Build Chat Control v3 local server', () => {
  it('is a distinct fail-closed owner-local generation', async () => {
    const root = await tempRoot();
    const sharedInstance = '33333333-3333-4333-8333-333333333333';
    const handle = await startNightBuildChatControlV3(root, dataSource(), {
      appVersion: '2.1.14',
      startedAt: 123,
      instanceId: sharedInstance
    });
    handles.push(handle);
    const discovery = handle.discovery;

    expect(discovery.host).toBe('127.0.0.1');
    expect(discovery.instanceId).toBe(sharedInstance);
    expect(discovery.startedAt).toBe(123);
    expect(discovery.capabilities).toEqual(['state', 'model-catalog', 'attachment-stage', 'configured-send', 'fresh-send']);
    expect((await request(discovery)).status).toBe(401);
    expect((await request(discovery, { token: discovery.token })).status).toBe(426);
    expect((await request(discovery, { ...auth(discovery), origin: 'https://example.invalid' })).status).toBe(403);
    expect((await request(discovery, { ...auth(discovery), protocol: '2' })).status).toBe(426);

    const file = path.join(root, NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid shared owner generation before publishing discovery', async () => {
    const root = await tempRoot();
    await expect(startNightBuildChatControlV3(root, dataSource(), { instanceId: 'not-a-generation' }))
      .rejects.toThrow('instance id is invalid');
    await expect(fs.stat(path.join(root, NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects only bounded model/context state for one opaque conversation', async () => {
    const root = await tempRoot();
    const state = vi.fn(dataSource().state);
    const handle = await startNightBuildChatControlV3(root, dataSource({ state }));
    handles.push(handle);
    const response = await request(handle.discovery, auth(handle.discovery));
    expect(response.status).toBe(200);
    expect(state).toHaveBeenCalledWith(CONVERSATION);
    const body = JSON.parse(response.text);
    expect(body.protocolVersion).toBe(3);
    expect(body.selectedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: 11 });
    expect(body.activeTurn).toEqual({ turnOrigin: 42, startedAt: 9 });
    expect(body.plan).toEqual({
      explanation: 'Keep the daily driver moving.',
      plan: [
        { step: 'Fix transcript activity', status: 'in_progress', details: 'Keep tools inline with prose.' },
        { step: 'Dogfood the candidate', status: 'pending' }
      ],
      updatedAt: 12
    });
    expect(body.context).toEqual({
      estimatedTokens: 113_646,
      configuredLimit: 533_333,
      configuredWarning: 400_000,
      autoCompaction: true,
      autoCompactionAt: 400_000
    });
    expect(response.text).not.toContain(handle.discovery.token);
  });

  it('accepts one strict fresh-send body without exposing provider Project identity', async () => {
    const root = await tempRoot();
    const createFreshSend = vi.fn(dataSource().createFreshSend);
    const handle = await startNightBuildChatControlV3(root, dataSource({ createFreshSend }));
    handles.push(handle);
    const body = JSON.stringify({
      id: SEND_ID,
      sourceConversation: CONVERSATION,
      text: 'Start a fresh chat here',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      attachments: []
    });
    const response = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: '/v3/fresh-send-intents',
      body
    });
    expect(response.status).toBe(202);
    expect(createFreshSend).toHaveBeenCalledWith({
      id: SEND_ID,
      sourceConversation: CONVERSATION,
      text: 'Start a fresh chat here',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      attachments: []
    });
    expect(JSON.parse(response.text)).toMatchObject({
      id: SEND_ID,
      destinationConversation: null,
      state: 'queued'
    });
    expect(response.text).not.toMatch(/g-p-|sourceConversation/);
  });

  it('stages raw bytes without accepting a filesystem path and carries only returned metadata into Send', async () => {
    const root = await tempRoot();
    const stageAttachment = vi.fn(dataSource().stageAttachment);
    const createSend = vi.fn(dataSource().createSend);
    const handle = await startNightBuildChatControlV3(root, dataSource({ stageAttachment, createSend }));
    handles.push(handle);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const staged = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: '/v3/attachments?name=shot.png',
      body: image
    });
    expect(staged.status).toBe(201);
    expect(stageAttachment).toHaveBeenCalledWith('shot.png', expect.any(Uint8Array));
    expect(staged.text).not.toContain('/Users/');

    const attachment = JSON.parse(staged.text).attachment;
    const body = {
      id: SEND_ID,
      conversation: CONVERSATION,
      text: 'inspect this screenshot',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      attachments: [attachment]
    };
    const sent = await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: '/v3/send-intents',
      body: JSON.stringify(body)
    });
    expect(sent.status).toBe(202);
    expect(createSend).toHaveBeenCalledWith(body);
  });

  it('rejects transfer-encoded and oversized attachment bodies before staging', async () => {
    const root = await tempRoot();
    const stageAttachment = vi.fn(dataSource().stageAttachment);
    const handle = await startNightBuildChatControlV3(root, dataSource({ stageAttachment }));
    handles.push(handle);
    expect((await request(handle.discovery, {
      ...auth(handle.discovery),
      method: 'POST',
      path: '/v3/attachments?name=shot.png',
      body: Buffer.from('x'),
      transferEncoding: 'chunked'
    })).status).toBe(400);
    expect(stageAttachment).not.toHaveBeenCalled();
  });
});
