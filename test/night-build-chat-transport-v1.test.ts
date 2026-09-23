import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNightBuildChatTransportSource, resolveNightBuildChatNativeSendProof } from '../src/main/night-build-chat-transport-source.js';
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
      ['user', 1, null, undefined],
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
    expect(poisoned.currentTurn).toEqual({ state: 'terminal', outcome: 'stopped', endedAt: 900 });
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
    expect(delta.currentTurn).toEqual({ state: 'terminal', outcome: 'completed', endedAt: 900 });
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
    expect(transcript.currentTurn).toEqual({ state: 'terminal', outcome: 'stopped', endedAt: 900 });
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

  it('does not treat the app-authored ACK projection as native ChatGPT acceptance proof', async () => {
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
    await expect(resolveNightBuildChatNativeSendProof(
      root, 'test-generation-secret', conversation!.handle, inputId
    )).resolves.toBeNull();

    // The later recorder echo of ChatGPT's own stable row carries the same
    // canonical key and retained inputId; only this extension observation may
    // establish Native Chat acceptance.
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
    )).resolves.toMatchObject({ messageId: 'message-user-0001', turnId: 'turn-0000001' });
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
});
