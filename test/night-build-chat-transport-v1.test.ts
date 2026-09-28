import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInProcessNightBuildChatTransportV2Source } from '../src/main/night-build-chat-transport-v2-source.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { listInputs, pendingBrowserInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import {
  appendEvent,
  createSession,
  flushSessions,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests,
  unsetSessionRootForTests,
  upsertMessageEvent
} from '../src/main/session/store.js';
import {
  createNightBuildChatTransportSource,
  nightBuildChatHandleForIdentity,
  resolveNightBuildChatNativeSendProof,
  resolveNightBuildChatNativeSendProofByIdentity
} from '../src/main/night-build-chat-transport-source.js';
import {
  startNightBuildChatTransportV1,
  type NightBuildChatTransportV1Handle
} from '../src/main/night-build-chat-transport-v1.js';
import {
  NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL_HEADER,
  type NightBuildChatTransportV1Discovery
} from '../src/shared/night-build-chat-transport-v1.js';

const roots: string[] = [];
const handles: NightBuildChatTransportV1Handle[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-night-build-chat-'));
  roots.push(root);
  return root;
}

function stored(text: string): { text: string; truncated: false; chars: number } {
  return { text, truncated: false, chars: text.length };
}

async function writeCanonical(dir: string, event: Record<string, unknown>): Promise<void> {
  const kind = String(event['kind']);
  const key = kind === 'tool_call'
    ? 'tool_call\0' + String((event['call'] as Record<string, unknown>)?.['callId'])
    : kind + '\0' + String(event['messageId']);
  const name = createHash('sha256').update(key).digest('hex') + '.json';
  await fs.mkdir(path.join(dir, 'messages'), { recursive: true });
  await fs.writeFile(path.join(dir, 'messages', name), JSON.stringify(event));
}

async function writeJournal(dir: string, events: Array<Record<string, unknown>>): Promise<void> {
  await fs.writeFile(path.join(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

async function writeContinuationWal(
  root: string,
  options: { token: string; sessionId: string; conversationId: string; handoffId: string; messageId: string }
): Promise<void> {
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'state', 'continuations.json'), JSON.stringify({
    version: 1,
    savedAt: 1_500,
    entries: [{
      token: options.token,
      sessionId: options.sessionId,
      from: 'conversation-old1',
      to: options.conversationId,
      openedAt: 1_000,
      state: 'committed',
      summary: 'fixture',
      handoffId: options.handoffId,
      claimedBy: 'fixture',
      destinationSend: {
        state: 'sent',
        conversationId: options.conversationId,
        messageId: options.messageId
      },
      error: null
    }]
  }));
}

async function writeFixture(root: string, options: {
  id?: string;
  conversationId?: string;
  chatIds?: string[];
  historySeq?: number;
  active?: boolean;
  outcome?: 'completed' | 'failed' | 'stopped' | 'interrupted' | 'stalled' | 'unknown' | null;
  resume?: boolean;
  inputId?: string;
} = {}): Promise<{ dir: string; meta: Record<string, unknown> }> {
  const id = options.id ?? 'session-0001';
  const conversationId = options.conversationId ?? 'conversation-0001';
  const dir = path.join(root, 'sessions', id);
  await fs.mkdir(path.join(dir, 'messages'), { recursive: true });
  const active = options.active ?? true;
  const meta: Record<string, unknown> = {
    id,
    title: 'Native Chat Fixture',
    conversationId,
    chatIds: options.chatIds ?? [conversationId],
    updatedAt: 1_000,
    endedAt: null,
    events: 8,
    userMessages: 1,
    toolCalls: 0,
    errors: 0,
    estimatedTokens: 10,
    contextTokens: 10,
    activeTurnId: active ? 'turn-0000001' : null,
    lastTurnOutcome: options.outcome ?? (active ? null : 'completed'),
    lastTurnEndAt: active ? null : 900,
    lastCommittedResumeHandoffId: options.resume ? 'handoff-0001' : null,
    timelineTurns: {
      'turn-0000001': { origin: 2, time: 200, questionId: 'message-user-0001', ...(active ? {} : { endTime: 900, endOrigin: 9 }) }
    },
    nativeQuestion: { messageId: 'message-user-0001', origin: 1 },
    requestTurns: {},
    __canonicalProjection: 1,
    __historySeq: options.historySeq ?? 8
  };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  await writeCanonical(dir, {
    seq: 1, time: 100, source: 'extension', kind: 'user_message',
    messageId: 'message-user-0001', message: stored('Hello from ordinary ChatGPT'),
    ...(options.inputId ? { inputId: options.inputId, inputDelivery: 'confirmed', authoredText: 'Hello from ordinary ChatGPT' } : {})
  });
  await writeCanonical(dir, {
    seq: 8, origin: 3, time: 300, source: 'extension', kind: 'assistant_message',
    turnId: 'turn-0000001', messageId: 'message-assistant-0001',
    providerMessageId: 'provider-message-0001',
    message: stored('Streaming answer'), state: 'streaming', final: false
  });
  await writeJournal(dir, [
    { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' }
  ]);
  return { dir, meta };
}

async function request(
  discovery: NightBuildChatTransportV1Discovery,
  options: { method?: string; path?: string; token?: string; protocol?: string; origin?: string; body?: string } = {}
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const body = options.body ?? '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: discovery.host,
      port: discovery.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/v1/conversations',
      headers: {
        ...(options.token === undefined ? {} : { authorization: 'Bearer ' + options.token }),
        ...(options.protocol === undefined ? {} : { [NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL_HEADER]: options.protocol }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
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

describe('Night Build Chat Transport v1 durable projection', () => {
  it('projects one current ordinary ChatGPT conversation without leaking recorder/browser identity', async () => {
    const root = await tempRoot();
    await writeFixture(root);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const conversations = await source.list();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ title: 'Native Chat Fixture' });
    expect(conversations[0]!.handle).not.toContain('session-0001');
    expect(conversations[0]!.handle).not.toContain('conversation-0001');

    const transcript = await source.transcript({ conversation: conversations[0]!.handle, limit: 100 });
    expect(transcript.projection).toEqual({
      current: true,
      identitySource: 'metadata',
      lowerBoundOrigin: 0,
      observedHighWaterSeq: 8,
      metadataHighWaterSeq: 8
    });
    expect(transcript.currentTurn).toEqual({ state: 'generating', turnOrigin: 2 });
    expect(transcript.items.map((item) => [item.role, item.revisionSeq, item.turnOrigin, item.state])).toEqual([
      ['user', 1, 2, undefined],
      ['assistant', 8, 2, 'streaming']
    ]);
    const encoded = JSON.stringify(transcript);
    for (const secret of ['session-0001', 'conversation-0001', 'message-user-0001', 'message-assistant-0001', 'turn-0000001']) {
      expect(encoded).not.toContain(secret);
    }
    expect(encoded).not.toContain('requestTurns');
    expect(encoded).not.toContain('providerMessageId');
    expect(encoded).not.toContain('renderedHtml');
  });

  it('projects revised visible commentary once at its first chronological position', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    await writeCanonical(fixture.dir, {
      seq: 8, origin: 6, time: 600, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000001', messageId: 'message-assistant-0001',
      providerMessageId: 'provider-message-0001',
      message: stored('Streaming answer'), state: 'streaming', final: false
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 3, time: 300, source: 'extension', kind: 'progress', turnId: 'turn-0000001',
        progressId: 'g-live-1#p0', message: stored('Checking the bridge') },
      { seq: 5, origin: 3, time: 300, source: 'extension', kind: 'progress', turnId: 'turn-0000001',
        progressId: 'g-live-1#p0', message: stored('Checking the bridge and recorder') },
      { seq: 7, time: 700, source: 'extension', kind: 'progress', turnId: 'turn-0000001',
        progressId: 'g-live-1#p1', message: stored('Streaming answer') }
    ]);

    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.items.map((item) => [item.text, item.originSeq, item.revisionSeq, item.state])).toEqual([
      ['Hello from ordinary ChatGPT', 1, 1, undefined],
      ['Checking the bridge and recorder', 3, 5, 'streaming'],
      ['Streaming answer', 6, 8, 'streaming']
    ]);
    const commentary = transcript.items[1]!;
    expect(commentary).toMatchObject({ role: 'assistant', authoredAt: 300, turnOrigin: 2 });
    expect(commentary.itemId).not.toContain('g-live-1#p0');
    // Exact provider prose is stronger than the DOM fallback and suppresses its duplicate.
    expect(transcript.items.filter((item) => item.text === 'Streaming answer')).toHaveLength(1);
  });

  it('excludes worker, helper and malformed internal origins from the ordinary Chat catalog', async () => {
    const root = await tempRoot();
    await writeFixture(root, { id: 'session-ordinary', conversationId: 'conversation-ordinary' });
    const worker = await writeFixture(root, { id: 'session-worker', conversationId: 'conversation-worker' });
    worker.meta['origin'] = { kind: 'worker', fromSessionId: 'session-ordinary', agentId: 'worker-1', task: 'Internal review' };
    await fs.writeFile(path.join(worker.dir, 'meta.json'), JSON.stringify(worker.meta));
    const helper = await writeFixture(root, { id: 'session-helper', conversationId: 'conversation-helper' });
    helper.meta['origin'] = { kind: 'helper', fromSessionId: 'session-ordinary', agentId: null, task: 'Internal helper' };
    await fs.writeFile(path.join(helper.dir, 'meta.json'), JSON.stringify(helper.meta));
    const malformed = await writeFixture(root, { id: 'session-malformed', conversationId: 'conversation-malformed' });
    malformed.meta['origin'] = { kind: 'future-internal-kind', task: 'Must fail closed' };
    await fs.writeFile(path.join(malformed.dir, 'meta.json'), JSON.stringify(malformed.meta));

    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const conversations = await source.list();
    expect(conversations).toHaveLength(1);
  });

  it('projects only the owner-visible user prompt and never the hidden COS context frame', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    const raw = '[[COS_CONTEXT:4]]\nseed\n[[/COS_CONTEXT]]\n\nOwner-visible prompt';
    await writeCanonical(fixture.dir, {
      seq: 1, time: 100, source: 'extension', kind: 'user_message',
      messageId: 'message-user-0001', authoredText: 'Owner-visible prompt', message: stored(raw)
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    const user = transcript.items.find((item) => item.role === 'user');
    expect(user?.text).toBe('Owner-visible prompt');
    expect(JSON.stringify(transcript)).not.toContain('COS_CONTEXT');
    expect(JSON.stringify(transcript)).not.toContain('seed');
  });

  it('accepts an empty journal and skips damaged rows without advancing the observed cursor', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();

    await fs.writeFile(path.join(fixture.dir, 'events.jsonl'), '');
    const empty = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(empty.projection.observedHighWaterSeq).toBe(8);

    await fs.writeFile(path.join(fixture.dir, 'events.jsonl'), [
      JSON.stringify({ seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' }),
      JSON.stringify({ seq: 99, time: 999, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'future-invalid-outcome' }),
      '{"seq":100'
    ].join('\n'));
    const damaged = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(damaged.projection.observedHighWaterSeq).toBe(8);

    await fs.writeFile(path.join(fixture.dir, 'events.jsonl'), [
      JSON.stringify({ seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' }),
      JSON.stringify({ seq: 98, time: 980, source: 'extension', kind: 'future_unknown_kind', payload: 'ignore' }),
      JSON.stringify({ seq: 99, time: 990, source: 'extension', kind: 'assistant_message', messageId: 'message-assistant-0001' }),
      JSON.stringify({ seq: 10, time: 900, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'stopped' })
    ].join('\n') + '\n');
    const poisoned = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(poisoned.projection.observedHighWaterSeq).toBe(10);
    expect(poisoned.currentTurn).toEqual({ state: 'terminal', outcome: 'stopped', endedAt: 900, turnOrigin: 2 });
  });

  it('uses revision seq as incremental cursor while preserving first-appearance origin', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();

    await writeCanonical(fixture.dir, {
      seq: 9, origin: 3, time: 500, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000001', messageId: 'message-assistant-0001',
      message: stored('Final answer'), state: 'final', final: true, finalContentSeq: 9
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 10, time: 900, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'completed' }
    ]);
    fixture.meta['__historySeq'] = 10;
    fixture.meta['updatedAt'] = 1_100;
    fixture.meta['activeTurnId'] = null;
    fixture.meta['lastTurnOutcome'] = 'completed';
    fixture.meta['lastTurnEndAt'] = 900;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));

    const delta = await source.transcript({ conversation: conversation!.handle, limit: 100, afterRevision: 8 });
    expect(delta.page.mode).toBe('incremental');
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]).toMatchObject({
      role: 'assistant', originSeq: 3, revisionSeq: 9, state: 'final', finalContentSeq: 9, text: 'Final answer'
    });
    expect(delta.currentTurn).toEqual({ state: 'terminal', outcome: 'completed', endedAt: 900, turnOrigin: 2 });
  });

  it('rebuilds installed 2.1.14 turn identity in memory when debounced metadata lags durable history', async () => {
    const root = await tempRoot();
    await writeFixture(root, { historySeq: 7 });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.projection).toMatchObject({
      current: true,
      identitySource: 'rebuilt',
      observedHighWaterSeq: 8,
      metadataHighWaterSeq: 7
    });
    expect(transcript.items.find((item) => item.role === 'assistant')?.turnOrigin).toBe(2);
    expect(transcript.currentTurn).toEqual({ state: 'generating', turnOrigin: 2 });
  });

  it('uses canonical request-owned tool shards when rebuilding reminted response identity', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { historySeq: 6 });
    fixture.meta['activeTurnId'] = 'turn-0000002';
    fixture.meta['updatedAt'] = 1_100;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    await writeCanonical(fixture.dir, {
      seq: 5, time: 500, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
      call: { callId: 'call-0000001', attribution: 'request_id', requestId: 'request-0000001', conversationId: 'conversation-0001' }
    });
    await writeCanonical(fixture.dir, {
      seq: 7, time: 700, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000002',
      call: { callId: 'call-0000002', attribution: 'request_id', requestId: 'request-0000001', conversationId: 'conversation-0001' }
    });
    await writeCanonical(fixture.dir, {
      seq: 8, origin: 8, time: 800, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000002', messageId: 'message-assistant-reminted',
      message: stored('Reminted response'), state: 'streaming', final: false
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 4, time: 400, source: 'extension', kind: 'turn_start', turnId: 'turn-0000002' },
      { seq: 5, time: 500, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001', call: { callId: 'call-0000001', attribution: 'request_id', requestId: 'stale-request', conversationId: 'conversation-wrong' } },
      { seq: 7, time: 700, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000002', call: { callId: 'call-0000002', attribution: 'request_id', requestId: 'stale-request', conversationId: 'conversation-wrong' } }
    ]);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.projection.identitySource).toBe('rebuilt');
    expect(transcript.items.find((item) => item.text === 'Reminted response')?.turnOrigin).toBe(2);
    expect(transcript.currentTurn).toEqual({ state: 'generating', turnOrigin: 2 });
  });

  it('recovers assistant turn origin from stable response identity when a reload row has no raw turn id', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { historySeq: 10 });
    const working = '11111111-1111-4111-8111-111111111111';
    const exchange = '22222222-2222-4222-8222-222222222222';
    await writeCanonical(fixture.dir, {
      seq: 9, origin: 9, time: 900, source: 'extension', kind: 'assistant_message', agent: 'prime',
      turnId: 'turn-0000001', messageId: `assistant:${working}:${exchange}:1790118100000`,
      message: stored('Turn-bound response observation'), state: 'streaming', final: false
    });
    await writeCanonical(fixture.dir, {
      seq: 10, origin: 10, time: 1_000, source: 'extension', kind: 'assistant_message', agent: 'prime',
      messageId: `assistant:${working}:${exchange}:1790118101000`,
      message: stored('Reloaded response observation'), state: 'final', final: true, finalContentSeq: 10
    });
    fixture.meta['__historySeq'] = 10;
    fixture.meta['updatedAt'] = 1_100;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    const reloaded = transcript.items.find((item) => item.text === 'Reloaded response observation');
    expect(reloaded?.turnOrigin).toBe(2);
    expect(reloaded?.authoredAt).toBe(1_790_118_101_000);
  });

  it('prefers explicit authored time over first observation time', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    await writeCanonical(fixture.dir, {
      seq: 1, time: 100, authoredAt: 77, source: 'extension', kind: 'user_message',
      messageId: 'message-user-0001', message: stored('Hello from ordinary ChatGPT')
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.items.find((item) => item.role === 'user')?.authoredAt).toBe(77);
  });

  it('accepts the September search-renderer fallback turn id on canonical messages without broadening chat ids', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    await writeCanonical(fixture.dir, {
      seq: 1, time: 100, source: 'extension', kind: 'user_message',
      turnId: 'fallback-turn-7:0:user',
      messageId: 'message-user-0001', message: stored('Hello from ordinary ChatGPT')
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.items.find((item) => item.role === 'user')).toMatchObject({
      text: 'Hello from ordinary ChatGPT',
      turnOrigin: 2
    });

    await writeCanonical(fixture.dir, {
      seq: 1, time: 100, source: 'extension', kind: 'user_message',
      turnId: 'fallback-turn-7:0:owner',
      messageId: 'message-user-0001', message: stored('Hello from ordinary ChatGPT')
    });
    await expect(source.transcript({ conversation: conversation!.handle, limit: 100 }))
      .rejects.toThrow('chat_transport_message_turn_invalid');
  });

  it('projects DOM-only screenshot attachments whose byte size is unknown without 500ing the transcript', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    await writeCanonical(fixture.dir, {
      seq: 1, time: 100, source: 'extension', kind: 'user_message',
      turnId: 'fallback-turn-7:0:user',
      messageId: 'message-user-0001',
      message: stored('Two screenshots'),
      attachments: [
        {
          id: 'visible:message-user-0001:0',
          name: 'Image 1',
          size: 0,
          mimeType: 'image/webp',
          preview: 'data:image/webp;base64,QUJDRA=='
        },
        {
          id: 'visible:message-user-0001:1',
          name: 'Image 2',
          size: 0,
          mimeType: 'image/webp',
          preview: 'data:image/webp;base64,RUZHSA=='
        }
      ]
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.items.find((item) => item.role === 'user')?.attachments).toEqual([
      expect.objectContaining({ name: 'Image 1', mimeType: 'image/webp', size: 0, preview: 'data:image/webp;base64,QUJDRA==' }),
      expect.objectContaining({ name: 'Image 2', mimeType: 'image/webp', size: 0, preview: 'data:image/webp;base64,RUZHSA==' })
    ]);
    expect(JSON.stringify(transcript)).not.toContain('visible:message-user-0001');
  });

  it('fails closed on a multi-chat lineage without a proven current RESUME boundary', async () => {
    const root = await tempRoot();
    await writeFixture(root, {
      chatIds: ['conversation-old1', 'conversation-0001'],
      resume: true
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    await expect(source.transcript({ conversation: conversation!.handle, limit: 100 }))
      .rejects.toThrow('chat_transport_resume_boundary_unproven');
  });

  it('excludes superseded-chat prose before the proven current RESUME boundary', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, {
      chatIds: ['conversation-old1', 'conversation-0001'],
      resume: true,
      historySeq: 12
    });
    await writeCanonical(fixture.dir, {
      seq: 10, time: 1_000, source: 'extension', kind: 'user_message',
      messageId: 'message-resume-0001',
      message: stored('[[CLF-RESUME:abcdefghijklmnop]]\n\nContinue here')
    });
    await writeCanonical(fixture.dir, {
      seq: 12, origin: 11, time: 1_100, source: 'extension', kind: 'assistant_message',
      messageId: 'message-assistant-0002', message: stored('Current chat answer'), state: 'final', final: true, finalContentSeq: 12
    });
    await writeContinuationWal(root, {
      token: 'abcdefghijklmnop',
      sessionId: 'session-0001',
      conversationId: 'conversation-0001',
      handoffId: 'handoff-0001',
      messageId: 'message-resume-0001'
    });
    fixture.meta['updatedAt'] = 1_200;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.projection.lowerBoundOrigin).toBe(10);
    expect(transcript.items.map((item) => item.text)).toEqual([
      '[[CLF-RESUME:abcdefghijklmnop]]\n\nContinue here',
      'Current chat answer'
    ]);
  });

  it('rejects malformed/future installed projection schema rather than reconstructing identity', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    fixture.meta['timelineTurns'] = [];
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    await expect(source.list()).rejects.toThrow('chat_transport_timeline_invalid');
  });

  it('uses durable handoff provenance when the continuation WAL has aged out', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, {
      chatIds: ['conversation-old1', 'conversation-0001'],
      resume: true,
      historySeq: 12
    });
    const summary = 'Durable handoff body with enough identity for an exact resume provenance check.';
    const bootstrap =
      '[[CLF-RESUME:abcdefghijklmnop]]\n\n' +
      'Continuing a Chat On Steroids session that was compacted. This is the brief the previous chat wrote about its own work; carry on from it rather than starting again.\n\n' +
      summary;
    await writeCanonical(fixture.dir, {
      seq: 10, time: 1_000, source: 'extension', kind: 'user_message',
      messageId: 'message-resume-0001', message: stored(bootstrap)
    });
    await writeCanonical(fixture.dir, {
      seq: 12, origin: 11, time: 1_100, source: 'extension', kind: 'assistant_message',
      messageId: 'message-assistant-0002', message: stored('Current chat answer'), state: 'final', final: true, finalContentSeq: 12
    });
    await fs.mkdir(path.join(fixture.dir, 'handoffs'), { recursive: true });
    await fs.writeFile(path.join(fixture.dir, 'handoffs', 'handoff-0001.json'), JSON.stringify({
      id: 'handoff-0001', sessionId: 'session-0001', createdAt: 900, text: summary,
      sourceEvents: 9, sourceTokens: 100, notes: []
    }));
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 9, time: 900, source: 'app', kind: 'handoff', handoffId: 'handoff-0001' }
    ]);
    fixture.meta['updatedAt'] = 1_200;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));

    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.projection.lowerBoundOrigin).toBe(10);
    expect(transcript.items.map((item) => item.text)).toEqual([bootstrap, 'Current chat answer']);
  });

  it('uses highest journal sequence for corrected terminal outcome instead of assistant-final state', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { active: false, historySeq: 11 });
    fixture.meta['activeTurnId'] = null;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 10, time: 800, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'failed' },
      { seq: 11, time: 900, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'stopped' }
    ]);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.currentTurn).toEqual({ state: 'terminal', outcome: 'stopped', endedAt: 900, turnOrigin: 2 });
  });

  it('lets durable turn_end settle stale active metadata and only the latest assistant row', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { active: true, historySeq: 12 });
    await writeCanonical(fixture.dir, {
      seq: 8, origin: 3, time: 300, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000001', messageId: 'message-assistant-0001',
      message: stored('Interim answer'), state: 'streaming', final: false
    });
    await writeCanonical(fixture.dir, {
      seq: 11, origin: 9, time: 700, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000001', messageId: 'message-assistant-0002',
      message: stored('Completed answer'), state: 'streaming', final: false
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      { seq: 12, time: 900, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'completed' }
    ]);
    fixture.meta['activeTurnId'] = 'turn-0000001';
    fixture.meta['__historySeq'] = 12;
    fixture.meta['updatedAt'] = 1_100;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));

    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.currentTurn).toEqual({
      state: 'terminal',
      outcome: 'completed',
      endedAt: 900,
      turnOrigin: 2
    });
    const assistants = transcript.items.filter((item) => item.role === 'assistant');
    expect(assistants.map((item) => [item.text, item.state])).toEqual([
      ['Interim answer', 'streaming'],
      ['Completed answer', 'final']
    ]);
  });

  it('collapses provider aliases with first identity and latest terminal content', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { historySeq: 9 });
    await writeCanonical(fixture.dir, {
      seq: 9, origin: 7, time: 700, source: 'extension', kind: 'assistant_message',
      turnId: 'turn-0000001', messageId: 'message-assistant-alias', providerMessageId: 'provider-message-0001',
      message: stored('Final provider-backed answer'), state: 'final', final: true, finalContentSeq: 9
    });
    fixture.meta['__historySeq'] = 9;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    const assistants = transcript.items.filter((item) => item.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      originSeq: 3,
      revisionSeq: 9,
      text: 'Final provider-backed answer',
      state: 'final'
    });
  });

  it('does not mutate owner durable files while cataloging and projecting', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root);
    const tracked = [
      path.join(fixture.dir, 'meta.json'),
      path.join(fixture.dir, 'events.jsonl'),
      ...(await fs.readdir(path.join(fixture.dir, 'messages'))).map((name) => path.join(fixture.dir, 'messages', name))
    ];
    const before = await Promise.all(tracked.map(async (file) => ({
      file,
      bytes: await fs.readFile(file),
      mtime: (await fs.stat(file)).mtimeMs
    })));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    await source.transcript({ conversation: conversation!.handle, limit: 100 });
    for (const original of before) {
      expect(await fs.readFile(original.file)).toEqual(original.bytes);
      expect((await fs.stat(original.file)).mtimeMs).toBe(original.mtime);
    }
  });

  it('proves a native Send only from the exact durable input id, native user row and turn question', async () => {
    const root = await tempRoot();
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeFixture(root, { inputId });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    expect(conversation).toBeDefined();
    await expect(resolveNightBuildChatNativeSendProof(root, 'test-generation-secret', conversation!.handle, 'different-input'))
      .resolves.toBeNull();
    await expect(resolveNightBuildChatNativeSendProof(root, 'test-generation-secret', conversation!.handle, inputId))
      .resolves.toMatchObject({
        messageId: 'message-user-0001',
        turnId: 'turn-0000001',
        turnOrigin: 2,
        revisionSeq: 1
      });
  });

  it('proves a native Send from durable user + turn-start evidence while summary metadata lags', async () => {
    const root = await tempRoot();
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeFixture(root, { inputId, historySeq: 1 });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    expect(conversation).toBeDefined();
    await expect(resolveNightBuildChatNativeSendProof(root, 'test-generation-secret', conversation!.handle, inputId))
      .resolves.toMatchObject({
        messageId: 'message-user-0001',
        turnId: 'turn-0000001',
        turnOrigin: 2,
        revisionSeq: 1
      });
  });

  it('uses an exact browser-acknowledged native message id while canonical input attribution lags', async () => {
    const root = await tempRoot();
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    await writeFixture(root, { historySeq: 1 });
    const [conversation] = await source.list();
    expect(conversation).toBeDefined();

    await expect(resolveNightBuildChatNativeSendProof(
      root,
      'test-generation-secret',
      conversation!.handle,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'message-user-0001'
    )).resolves.toMatchObject({
      messageId: 'message-user-0001',
      turnId: 'turn-0000001',
      turnOrigin: 2,
      revisionSeq: 1
    });
  });

  it('rejects a wrong or conflicting browser-acknowledged native message identity', async () => {
    const root = await tempRoot();
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeFixture(root, { historySeq: 1, inputId: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb' });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    expect(conversation).toBeDefined();

    await expect(resolveNightBuildChatNativeSendProof(
      root,
      'test-generation-secret',
      conversation!.handle,
      inputId,
      'wrong-message-id'
    )).resolves.toBeNull();
    await expect(resolveNightBuildChatNativeSendProof(
      root,
      'test-generation-secret',
      conversation!.handle,
      inputId,
      'message-user-0001'
    )).resolves.toBeNull();
  });

  it('proves acceptance from the confirmed app input row and keeps the extension echo on the same receipt', async () => {
    const root = await tempRoot();
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const fixture = await writeFixture(root, { inputId });
    await writeCanonical(fixture.dir, {
      seq: 1,
      time: 100,
      source: 'app',
      kind: 'user_message',
      messageId: 'message-user-0001',
      inputId,
      inputDelivery: 'confirmed',
      authoredText: 'Hello from ordinary ChatGPT',
      message: stored('Hello from ordinary ChatGPT')
    });
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const receipt = {
      messageId: 'message-user-0001',
      turnId: 'turn-0000001',
      turnOrigin: 2,
      revisionSeq: 1
    };
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId
    )).resolves.toEqual(receipt);
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId, 'message-user-0001'
    )).resolves.toEqual(receipt);

    // A later page echo of the same canonical key keeps this receipt.
    await writeCanonical(fixture.dir, {
      seq: 9,
      origin: 1,
      time: 110,
      source: 'extension',
      kind: 'user_message',
      messageId: 'message-user-0001',
      inputId,
      inputDelivery: 'confirmed',
      authoredText: 'Hello from ordinary ChatGPT',
      message: stored('Hello from ordinary ChatGPT')
    });
    fixture.meta['__historySeq'] = 9;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId
    )).resolves.toMatchObject({ messageId: 'message-user-0001', turnId: 'turn-0000001', turnOrigin: 2 });
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId, 'message-user-0001'
    )).resolves.toMatchObject({ messageId: 'message-user-0001', turnId: 'turn-0000001', turnOrigin: 2 });
  });

  it('rejects a confirmed app row that sits before the current resume lower bound', async () => {
    const root = await tempRoot();
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const fixture = await writeFixture(root, {
      chatIds: ['conversation-old1', 'conversation-0001'],
      resume: true,
      historySeq: 12,
      inputId
    });
    await writeCanonical(fixture.dir, {
      seq: 1,
      time: 100,
      source: 'app',
      kind: 'user_message',
      messageId: 'message-user-0001',
      inputId,
      inputDelivery: 'confirmed',
      authoredText: 'Hello from ordinary ChatGPT',
      message: stored('Hello from ordinary ChatGPT')
    });
    await writeCanonical(fixture.dir, {
      seq: 10, time: 1_000, source: 'extension', kind: 'user_message',
      messageId: 'message-resume-0001',
      message: stored('[[CLF-RESUME:abcdefghijklmnop]]\n\nContinue here')
    });
    await writeContinuationWal(root, {
      token: 'abcdefghijklmnop',
      sessionId: 'session-0001',
      conversationId: 'conversation-0001',
      handoffId: 'handoff-0001',
      messageId: 'message-resume-0001'
    });
    fixture.meta['updatedAt'] = 1_200;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId, 'message-user-0001'
    )).resolves.toBeNull();
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId
    )).resolves.toBeNull();
  });
});

describe('recordDeliveredInput confirmed app row proves Native Chat acceptance', () => {
  const salt = 'test-generation-secret';
  const turnId = 'turn-native-0001';
  let userData = '';

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-native-app-proof-'));
    initSessionStore(userData);
  });

  afterEach(async () => {
    resetInputForTests();
    resetDurableForTests();
    resetSessionStoreForTests();
    unsetSessionRootForTests();
    if (userData) await fs.rm(userData, { recursive: true, force: true });
  });

  async function deliverConfirmed(options: {
    conversationId?: string;
    messageId?: string;
    inputId?: string;
    text?: string;
    withTurn?: boolean;
    turn?: string;
  } = {}) {
    const conversationId = options.conversationId ?? 'conv-native-0001';
    const messageId = options.messageId ?? 'msg-user-native-0001';
    const inputId = options.inputId ?? '11111111-1111-4111-8111-111111111111';
    const text = options.text ?? 'Hello from the confirmed native send';
    const session = await createSession({ conversationId, title: 'Native send proof' });
    const entry = {
      id: inputId,
      sessionId: session.id,
      conversationId,
      state: 'sent',
      messageId,
      deliveredAt: 300,
      text
    } as InputEntry;
    expect(await recordDeliveredInput(entry)).toBe(true);
    if (options.withTurn !== false) {
      await appendEvent(session.id, {
        source: 'extension',
        time: 400,
        kind: 'turn_start',
        turnId: options.turn ?? turnId
      });
    }
    await flushSessions();
    const recorded = (await readEvents(session.id)).find((event) => event.kind === 'user_message');
    expect(recorded).toMatchObject({
      source: 'app',
      kind: 'user_message',
      messageId,
      inputId,
      inputDelivery: 'confirmed'
    });
    return { session, conversationId, messageId, inputId, text };
  }

  async function prove(
    sessionId: string,
    conversationId: string,
    inputId: string,
    expectedMessageId?: string
  ) {
    const handle = await nightBuildChatHandleForIdentity(userData, salt, sessionId, conversationId);
    expect(handle).toBeTruthy();
    return resolveNightBuildChatNativeSendProof(userData, salt, handle!, inputId, expectedMessageId);
  }

  it('resolves native acceptance from the exact confirmed app row', async () => {
    const delivered = await deliverConfirmed();
    const receipt = {
      messageId: delivered.messageId,
      turnId,
      turnOrigin: 2,
      revisionSeq: 1
    };
    await expect(prove(
      delivered.session.id, delivered.conversationId, delivered.inputId, delivered.messageId
    )).resolves.toEqual(receipt);
    await expect(prove(
      delivered.session.id, delivered.conversationId, delivered.inputId
    )).resolves.toEqual(receipt);
  });

  it('still proves the extension user row with the same turn receipt', async () => {
    const conversationId = 'conv-native-0001';
    const messageId = 'msg-user-native-0001';
    const inputId = '11111111-1111-4111-8111-111111111111';
    const text = 'Hello from the extension echo';
    const session = await createSession({ conversationId, title: 'Extension echo' });
    await upsertMessageEvent(session.id, {
      source: 'extension',
      kind: 'user_message',
      time: 100,
      messageId,
      inputId,
      inputDelivery: 'confirmed',
      message: { text, chars: text.length, truncated: false }
    });
    await appendEvent(session.id, { source: 'extension', time: 400, kind: 'turn_start', turnId });
    await flushSessions();
    await expect(prove(session.id, conversationId, inputId, messageId)).resolves.toMatchObject({
      messageId,
      turnId,
      turnOrigin: 2
    });
    await expect(prove(session.id, conversationId, inputId)).resolves.toMatchObject({
      messageId,
      turnId
    });
  });

  it('rejects an app row whose input id is missing or different', async () => {
    const delivered = await deliverConfirmed();
    await expect(prove(
      delivered.session.id,
      delivered.conversationId,
      '22222222-2222-4222-8222-222222222222',
      delivered.messageId
    )).resolves.toBeNull();

    const bare = await createSession({ conversationId: 'conv-native-0002', title: 'Missing input id' });
    const text = 'App prose without an outbox id';
    await upsertMessageEvent(bare.id, {
      source: 'app',
      kind: 'user_message',
      time: 100,
      messageId: 'msg-user-native-0002',
      inputDelivery: 'confirmed',
      message: { text, chars: text.length, truncated: false }
    });
    await appendEvent(bare.id, { source: 'extension', time: 400, kind: 'turn_start', turnId: 'turn-native-0002' });
    await flushSessions();
    await expect(prove(
      bare.id, 'conv-native-0002', delivered.inputId, 'msg-user-native-0002'
    )).resolves.toBeNull();
  });

  it('rejects offered and tool-keyed app rows', async () => {
    const session = await createSession({ conversationId: 'conv-native-0003', title: 'Offered input' });
    const inputId = '33333333-3333-4333-8333-333333333333';
    const text = 'Waiting for a tool receipt';
    await upsertMessageEvent(session.id, {
      source: 'app',
      kind: 'user_message',
      time: 100,
      messageId: 'msg-user-native-0003',
      inputId,
      inputDelivery: 'offered',
      message: { text, chars: text.length, truncated: false }
    });
    await appendEvent(session.id, { source: 'extension', time: 400, kind: 'turn_start', turnId: 'turn-native-0003' });
    await flushSessions();
    await expect(prove(session.id, 'conv-native-0003', inputId, 'msg-user-native-0003')).resolves.toBeNull();

    const tool = await createSession({ conversationId: 'conv-native-0004', title: 'Tool input' });
    const toolId = '44444444-4444-4444-8444-444444444444';
    expect(await recordDeliveredInput({
      id: toolId,
      sessionId: tool.id,
      state: 'sent',
      messageId: `input:${toolId}`,
      deliveredAt: 300,
      text: 'Tool handout confirmed'
    } as InputEntry)).toBe(true);
    await appendEvent(tool.id, { source: 'extension', time: 400, kind: 'turn_start', turnId: 'turn-native-0004' });
    await flushSessions();
    const toolRow = (await readEvents(tool.id)).find((event) => event.kind === 'user_message');
    expect(toolRow).toMatchObject({ source: 'app', inputDelivery: 'confirmed', messageId: `input:${toolId}` });
    await expect(prove(tool.id, 'conv-native-0004', toolId, `input:${toolId}`)).resolves.toBeNull();
    await expect(prove(tool.id, 'conv-native-0004', toolId)).resolves.toBeNull();
  });

  it('rejects the wrong ChatGPT message id, another session, and a decision row', async () => {
    const delivered = await deliverConfirmed();
    await expect(prove(
      delivered.session.id, delivered.conversationId, delivered.inputId, 'msg-user-other-9999'
    )).resolves.toBeNull();
    const other = await createSession({ conversationId: 'conv-native-0099', title: 'Other chat' });
    await flushSessions();
    await expect(prove(other.id, 'conv-native-0099', delivered.inputId, delivered.messageId)).resolves.toBeNull();

    const helper = await createSession({
      conversationId: 'conv-helper-0001',
      title: 'Helper chat',
      origin: { kind: 'helper', fromSessionId: null, agentId: null, task: 'decide' }
    });
    expect(await recordDeliveredInput({
      id: '99999999-9999-4999-8999-999999999991',
      sessionId: helper.id,
      conversationId: 'conv-helper-0001',
      state: 'sent',
      messageId: 'msg-helper-decision-1',
      deliveredAt: 280,
      purpose: 'decision',
      text: 'Helper decision'
    } as InputEntry)).toBe(false);
    expect(await recordDeliveredInput({
      id: '99999999-9999-4999-8999-999999999999',
      sessionId: helper.id,
      conversationId: 'conv-helper-0001',
      state: 'sent',
      messageId: 'msg-helper-user-0001',
      deliveredAt: 300,
      text: 'Helper user row'
    } as InputEntry)).toBe(true);
    await appendEvent(helper.id, { source: 'extension', time: 400, kind: 'turn_start', turnId: 'turn-helper-0001' });
    await flushSessions();
    expect(await nightBuildChatHandleForIdentity(userData, salt, helper.id, 'conv-helper-0001')).toBeNull();
    expect((await readEvents(helper.id)).some((event) => event.kind === 'user_message' && event.messageId === 'msg-helper-decision-1')).toBe(false);
  });

  it('fails closed when two confirmed rows share the input id or two turns share the question', async () => {
    const conversationId = 'conv-native-0005';
    const inputId = '55555555-5555-4555-8555-555555555555';
    const session = await createSession({ conversationId, title: 'Ambiguous rows' });
    expect(await recordDeliveredInput({
      id: inputId, sessionId: session.id, conversationId, state: 'sent',
      messageId: 'msg-user-native-0005a', deliveredAt: 300, text: 'First confirmed row'
    } as InputEntry)).toBe(true);
    expect(await recordDeliveredInput({
      id: inputId, sessionId: session.id, conversationId, state: 'sent',
      messageId: 'msg-user-native-0005b', deliveredAt: 320, text: 'Second confirmed row'
    } as InputEntry)).toBe(true);
    await appendEvent(session.id, { source: 'extension', time: 400, kind: 'turn_start', turnId });
    await flushSessions();
    await expect(prove(session.id, conversationId, inputId)).resolves.toBeNull();
    await expect(prove(session.id, conversationId, inputId, 'msg-user-native-0005a')).resolves.toBeNull();

    const split = await createSession({ conversationId: 'conv-native-0006', title: 'Two turns' });
    expect(await recordDeliveredInput({
      id: '66666666-6666-4666-8666-666666666666',
      sessionId: split.id,
      conversationId: 'conv-native-0006',
      state: 'sent',
      messageId: 'msg-user-native-0006',
      deliveredAt: 300,
      text: 'One question, two turns'
    } as InputEntry)).toBe(true);
    await appendEvent(split.id, { source: 'extension', time: 400, kind: 'turn_start', turnId: 'turn-native-0006' });
    await appendEvent(split.id, { source: 'extension', time: 500, kind: 'turn_start', turnId: 'turn-native-0007' });
    await flushSessions();
    await expect(prove(
      split.id, 'conv-native-0006', '66666666-6666-4666-8666-666666666666', 'msg-user-native-0006'
    )).resolves.toBeNull();
  });

  it('requires the timeline turn questionId to be that exact message', async () => {
    const delivered = await deliverConfirmed({ withTurn: false });
    await expect(prove(
      delivered.session.id, delivered.conversationId, delivered.inputId, delivered.messageId
    )).resolves.toBeNull();

    const early = await createSession({ conversationId: 'conv-native-0008', title: 'Turn before question' });
    await appendEvent(early.id, { source: 'extension', time: 100, kind: 'turn_start', turnId: 'turn-native-0008' });
    expect(await recordDeliveredInput({
      id: '88888888-8888-4888-8888-888888888888',
      sessionId: early.id,
      conversationId: 'conv-native-0008',
      state: 'sent',
      messageId: 'msg-user-native-0008',
      deliveredAt: 300,
      text: 'Question arrived after the turn'
    } as InputEntry)).toBe(true);
    await flushSessions();
    await expect(prove(
      early.id, 'conv-native-0008', '88888888-8888-4888-8888-888888888888', 'msg-user-native-0008'
    )).resolves.toBeNull();
  });

  it('stamps nativeChat.acceptance on the same id and does not create another browser send', async () => {
    initDurableStore(userData);
    resetInputForTests();
    const delivered = await deliverConfirmed();
    const outbox: InputEntry = {
      id: delivered.inputId,
      sessionId: delivered.session.id,
      text: delivered.text,
      mode: 'auto',
      dueAt: 100,
      model: null,
      reasoningEffort: null,
      state: 'sent',
      owner: 'native-document-1',
      createdAt: 100,
      conversationId: delivered.conversationId,
      messageId: delivered.messageId,
      deliveredAt: 300,
      offeredAt: 200,
      sendAuthorizedAt: 250,
      transportIntent: 'browser',
      historyRecorded: true,
      nativeChat: { sessionId: delivered.session.id, conversationId: delivered.conversationId }
    };
    await writeDurableNow('session-input', [outbox]);
    resetInputForTests();
    const transport = createInProcessNightBuildChatTransportV2Source(userData, salt);
    const first = await transport.send(delivered.inputId);
    const stopProof = await resolveNightBuildChatNativeSendProofByIdentity(
      userData, salt, delivered.session.id, delivered.conversationId, delivered.inputId
    );
    expect(stopProof).toMatchObject({ messageId: delivered.messageId, turnId, turnOrigin: 2 });
    expect(first).toMatchObject({
      id: delivered.inputId,
      state: 'nativeAcceptanceProved',
      error: null,
      receipt: {
        userMessage: createHash('sha256').update('user-message').update('\0').update(salt).update('\0')
          .update(delivered.session.id + '\0' + stopProof!.messageId).digest('base64url'),
        turn: createHash('sha256').update('turn').update('\0').update(salt).update('\0')
          .update(delivered.session.id + '\0' + stopProof!.turnId).digest('base64url'),
        turnOrigin: stopProof!.turnOrigin
      }
    });
    const stamped = (await listInputs()).find((entry) => entry.id === delivered.inputId);
    expect(stamped?.nativeChat?.acceptance).toEqual(stopProof);
    expect(stamped).toMatchObject({ state: 'sent', messageId: delivered.messageId, historyRecorded: true });

    const second = await transport.send(delivered.inputId);
    expect(second).toEqual(first);
    const replay = await transport.createSend({
      id: delivered.inputId,
      conversation: first!.conversation,
      text: delivered.text
    });
    expect(replay).toMatchObject({
      id: delivered.inputId,
      state: 'nativeAcceptanceProved',
      receipt: first!.receipt,
      error: null
    });
    expect(await listInputs()).toHaveLength(1);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await transport.inspectSend(delivered.inputId)).toEqual(first);
  });
});

describe('Night Build Chat Transport v1 local server', () => {
  it('keeps the transport import graph outside browser, MCP, provider and Electron authority', async () => {
    const root = path.resolve(import.meta.dirname, '..', 'src', 'main');
    const source = (await Promise.all([
      'night-build-chat-transport-sidecar.ts',
      'night-build-chat-transport-source.ts',
      'night-build-chat-transport-v1.ts',
      'night-build-bridge-owner.ts'
    ].map((name) => fs.readFile(path.join(root, name), 'utf8')))).join('\\n');
    expect(source).not.toMatch(/from ['"].*\/mcp\//);
    expect(source).not.toContain("from './bridge.js'");
    expect(source).not.toContain("from './connection.js'");
    expect(source).not.toContain("from './secrets.js'");
    expect(source).not.toContain("from 'electron'");
    expect(source).not.toContain('chrome.');
  });

  it('enforces separate discovery, bearer, protocol, GET-only, body and browser-origin fences', async () => {
    const root = await tempRoot();
    await writeFixture(root);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const handle = await startNightBuildChatTransportV1(root, source, { appVersion: '2.1.14', ownershipPollMs: 60_000 });
    handles.push(handle);
    const discovery = handle.discovery;
    expect((await request(discovery)).status).toBe(401);
    expect((await request(discovery, { token: 'wrong', protocol: '1' })).status).toBe(401);
    expect((await request(discovery, { token: discovery.token })).status).toBe(426);
    expect((await request(discovery, { token: discovery.token, protocol: '999' })).status).toBe(426);
    expect((await request(discovery, { method: 'POST', token: discovery.token, protocol: '1' })).status).toBe(405);
    expect((await request(discovery, { token: discovery.token, protocol: '1', body: 'x' })).status).toBe(400);
    const browser = await request(discovery, { token: discovery.token, protocol: '1', origin: 'https://example.invalid' });
    expect(browser.status).toBe(403);
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(discovery, { path: '/v2/status', token: discovery.token, protocol: '1' })).status).toBe(404);

    const ok = await request(discovery, { token: discovery.token, protocol: '1' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).not.toContain(discovery.token);
    expect(ok.text).not.toContain(discovery.instanceId);
    const body = JSON.parse(ok.text) as { conversations: Array<{ handle: string }> };
    const transcript = await request(discovery, {
      path: '/v1/transcript?conversation=' + encodeURIComponent(body.conversations[0]!.handle) + '&limit=100',
      token: discovery.token,
      protocol: '1'
    });
    expect(transcript.status).toBe(200);

    const file = path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('re-proves exact discovery/owner after an awaited projection and self-stops on ownership loss', async () => {
    const root = await tempRoot();
    let started!: () => void;
    let release!: () => void;
    const projectionStarted = new Promise<void>((resolve) => { started = resolve; });
    const projectionRelease = new Promise<void>((resolve) => { release = resolve; });
    let alive = true;
    const source = {
      list: async () => {
        started();
        await projectionRelease;
        return [];
      },
      transcript: async () => { throw new Error('unused'); }
    };
    const handle = await startNightBuildChatTransportV1(root, source, {
      ownerIsCurrent: async () => alive,
      ownershipPollMs: 60_000
    });
    handles.push(handle);
    const pending = request(handle.discovery, { token: handle.discovery.token, protocol: '1' });
    await projectionStarted;
    alive = false;
    release();
    expect((await pending).status).toBe(503);
    expect(await handle.checkOwnershipNow()).toBe(false);
    await expect(fs.readFile(path.join(root, NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects journal-only git activity between the prompt and the final answer', async () => {
    const root = await tempRoot();
    const home = os.homedir();
    const fixture = await writeFixture(root, { historySeq: 10, active: false, outcome: 'completed' });
    fixture.meta['timelineTurns'] = {
      'turn-0000001': { origin: 1, time: 100, questionId: 'message-user-0001', endTime: 600, endOrigin: 6 }
    };
    fixture.meta['__historySeq'] = 10;
    fixture.meta['activeTurnId'] = null;
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    await writeCanonical(fixture.dir, {
      seq: 1, origin: 1, time: 100, source: 'extension', kind: 'user_message', turnId: 'turn-0000001',
      messageId: 'message-user-0001', message: stored('Show the git state')
    });
    await writeCanonical(fixture.dir, {
      seq: 6, origin: 6, time: 600, source: 'extension', kind: 'assistant_message', turnId: 'turn-0000001',
      messageId: 'message-assistant-0001', message: stored('Working tree is clean'),
      state: 'final', final: true, finalContentSeq: 6
    });
    const call = (callId: string, seq: number, title: string) => ({
      seq, origin: seq, time: seq * 100, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
      call: {
        callId,
        tool: 'exec_command',
        attribution: 'request_id',
        attributionMethod: 'request_id',
        requestId: 'request-CANARY-0001',
        conversationId: 'conversation-0001',
        nested: false,
        args: { text: `ARGS-CANARY ${home}/secret Bearer CANARYTOKEN`, command: 'git status --short' },
        result: { text: 'RESULT-CANARY sk-proj-abcdefghijklmnopqrstuvwxyz012345' },
        outcome: 'ok',
        durationMs: 18,
        summary: {
          kind: 'run',
          tone: 'good',
          title: `${title} in ${home}/Developer`,
          detail: 'Bearer CANARYTOKEN sk-proj-abcdefghijklmnopqrstuvwxyz012345'
        }
      }
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      call('call-CANARY-status', 3, 'Ran git status --short'),
      call('call-CANARY-head', 4, 'Ran git rev-parse HEAD'),
      { seq: 5, time: 500, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'completed' },
      {
        seq: 7, time: 700, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
        call: {
          ...call('call-CANARY-nested', 7, 'Ran nested').call,
          nested: true
        }
      },
      {
        seq: 8, time: 800, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
        call: { ...call('call-CANARY-foreign', 8, 'Ran foreign').call, conversationId: 'conversation-other' }
      },
      {
        seq: 9, time: 900, source: 'mcp', kind: 'tool_call',
        call: { ...call('call-CANARY-unattributed', 9, 'Ran unattributed').call, attribution: 'unattributed', attributionMethod: 'unattributed' }
      },
      {
        seq: 10, time: 1_000, source: 'mcp', kind: 'tool_call', turnId: 'turn-missing',
        call: call('call-CANARY-noturn', 10, 'Ran without turn').call
      }
    ]);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.items.map((item) => item.text)).toEqual(['Show the git state', 'Working tree is clean']);
    expect(transcript.activity.map((row) => row.title)).toEqual([
      'Ran git status --short in ~/Developer',
      'Ran git rev-parse HEAD in ~/Developer'
    ]);
    expect(transcript.activity.map((row) => row.phase)).toEqual(['completed', 'completed']);
    expect(transcript.activity.every((row) => row.turnOrigin === 1)).toBe(true);
    expect(transcript.page.earliestOrigin).toBe(1);
    const encoded = JSON.stringify(transcript);
    for (const canary of [
      'call-CANARY-status', 'call-CANARY-head', 'call-CANARY-nested', 'call-CANARY-foreign',
      'call-CANARY-unattributed', 'call-CANARY-noturn', 'request-CANARY-0001', 'conversation-0001',
      'session-0001', 'turn-0000001', 'ARGS-CANARY', 'RESULT-CANARY', 'CANARYTOKEN',
      'sk-proj-abcdefghijklmnopqrstuvwxyz012345', home
    ]) {
      expect(encoded).not.toContain(canary);
    }
  });

  it('folds a canonical process completion over the journal launch and pages by revision', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { historySeq: 9, active: false, outcome: 'completed' });
    fixture.meta['timelineTurns'] = {
      'turn-0000001': { origin: 1, time: 100, questionId: 'message-user-0001', endTime: 900, endOrigin: 9 }
    };
    fixture.meta['__historySeq'] = 9;
    fixture.meta['activeTurnId'] = null;
    fixture.meta['requestTurns'] = {
      'request-CANARY-proc': { turnId: 'turn-0000001', conversationId: 'conversation-0001', origin: 1 }
    };
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    await writeCanonical(fixture.dir, {
      seq: 9, origin: 4, time: 900, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
      call: {
        callId: 'call-CANARY-proc',
        tool: 'exec_command',
        attribution: 'request_id',
        attributionMethod: 'request_id',
        requestId: 'request-CANARY-proc',
        conversationId: 'conversation-0001',
        args: { text: 'ARGS-CANARY' },
        result: { text: 'RESULT-CANARY' },
        outcome: 'ok',
        durationMs: 20,
        process: { sessionId: 'process-CANARY', completedAt: 900, exitCode: 0, durationMs: 4_200 },
        summary: { kind: 'process', tone: 'good', title: 'Running focused tests', metric: '✓ 4.2s' },
        changes: [{ path: `${os.homedir()}/secret.ts`, added: 1, removed: 0, approximate: false }]
      }
    });
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      {
        seq: 4, origin: 4, time: 400, source: 'mcp', kind: 'tool_call', turnId: 'turn-0000001',
        call: {
          callId: 'call-CANARY-proc',
          tool: 'exec_command',
          attribution: 'request_id',
          attributionMethod: 'request_id',
          requestId: 'request-CANARY-proc',
          conversationId: 'conversation-0001',
          args: { text: 'ARGS-CANARY' },
          result: { text: '' },
          outcome: 'ok',
          durationMs: 1,
          process: { sessionId: 'process-CANARY' },
          summary: { kind: 'process', tone: 'neutral', title: 'Running focused tests', metric: 'running' }
        }
      },
      { seq: 8, time: 800, source: 'extension', kind: 'turn_end', turnId: 'turn-0000001', outcome: 'completed' }
    ]);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const recent = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(recent.activity).toHaveLength(1);
    expect(recent.activity[0]).toMatchObject({
      originSeq: 4,
      revisionSeq: 9,
      phase: 'finished',
      metric: '✓ 4.2s',
      title: 'Running focused tests',
      changedFiles: 1,
      changedPaths: ['~/secret.ts']
    });
    expect(recent.activity[0]!.activityId).not.toContain('call-CANARY-proc');
    const encoded = JSON.stringify(recent);
    for (const canary of ['call-CANARY-proc', 'request-CANARY-proc', 'process-CANARY', 'ARGS-CANARY', 'RESULT-CANARY', os.homedir()]) {
      expect(encoded).not.toContain(canary);
    }
    const delta = await source.transcript({ conversation: conversation!.handle, limit: 100, afterRevision: 8 });
    expect(delta.items).toHaveLength(0);
    expect(delta.activity.map((row) => row.revisionSeq)).toEqual([9]);
    const settled = await source.transcript({ conversation: conversation!.handle, limit: 100, afterRevision: 9 });
    expect(settled.activity).toEqual([]);
    expect(settled.items).toEqual([]);
    const earlier = await source.transcript({ conversation: conversation!.handle, limit: 100, beforeOrigin: 4 });
    expect(earlier.activity).toEqual([]);
    expect(earlier.items.some((item) => item.role === 'user')).toBe(true);
  });

  it('projects a request-owned call only when that request belongs to the current conversation', async () => {
    const root = await tempRoot();
    const fixture = await writeFixture(root, { historySeq: 8, active: true });
    fixture.meta['__historySeq'] = 8;
    fixture.meta['requestTurns'] = {
      'request-owned-0001': { turnId: 'turn-0000001', conversationId: 'conversation-0001', origin: 2 },
      'request-foreign-001': null
    };
    await fs.writeFile(path.join(fixture.dir, 'meta.json'), JSON.stringify(fixture.meta));
    const baseCall = {
      tool: 'exec_command',
      attribution: 'request_id',
      attributionMethod: 'request_id',
      conversationId: 'conversation-0001',
      outcome: 'ok',
      durationMs: 5,
      args: { text: 'hidden' },
      result: { text: 'hidden' },
      summary: { kind: 'run', tone: 'neutral', title: 'Ran owned command' }
    };
    await writeJournal(fixture.dir, [
      { seq: 2, time: 200, source: 'extension', kind: 'turn_start', turnId: 'turn-0000001' },
      {
        seq: 3, origin: 3, time: 300, source: 'mcp', kind: 'tool_call',
        call: { ...baseCall, callId: 'call-owned-0001', requestId: 'request-owned-0001' }
      },
      {
        seq: 4, origin: 4, time: 400, source: 'mcp', kind: 'tool_call',
        call: { ...baseCall, callId: 'call-foreign-0001', requestId: 'request-foreign-001', title: 'should not matter' }
      }
    ]);
    const source = createNightBuildChatTransportSource(root, 'test-generation-secret');
    const [conversation] = await source.list();
    const transcript = await source.transcript({ conversation: conversation!.handle, limit: 100 });
    expect(transcript.activity.map((row) => row.title)).toEqual(['Ran owned command']);
    expect(transcript.activity[0]!.turnOrigin).toBe(2);
    expect(JSON.stringify(transcript)).not.toContain('call-owned-0001');
    expect(JSON.stringify(transcript)).not.toContain('request-owned-0001');
  });
});
