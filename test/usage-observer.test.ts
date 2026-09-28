import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function harness(prepare?: (page: Record<string, any>) => void, options: { crypto?: boolean } = {}) {
  const posts: Array<Record<string, any>> = [];
  const attemptedPosts: Array<Record<string, any>> = [];
  let now = Date.parse('2026-09-05T12:00:00Z');
  class Clock extends Date { static override now() { return now; } }
  let response: unknown;
  let nextBodyGate: Promise<void> | null = null;
  let nextSseGate: Promise<void> | null = null;
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerId = 0;
  const listeners = new Map<string, Array<{ handler: (event: any) => void; once: boolean; capture: boolean }>>();
  const document = { readyState: 'loading' };
  class Socket {
    static OPEN = 1;
    handlers: Array<{ type: string; listener: (event: any) => void }> = [];
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: any) => void) { this.handlers.push({ type, listener }); }
    removeEventListener(type: string, listener: (event: any) => void) {
      this.handlers = this.handlers.filter(row => row.type !== type || row.listener !== listener);
    }
    receive(data: unknown) { for (const row of this.handlers.filter(item => item.type === 'message')) row.listener({ data: JSON.stringify(data) }); }
    close() { for (const row of this.handlers.filter(item => item.type === 'close')) row.listener({}); }
  }
  const window: Record<string, any> = {
    WebSocket: Socket,
    fetch: (..._args: unknown[]) => Promise.resolve(response),
    postMessage: (data: unknown, targetOrigin?: string) => {
      const copied = JSON.parse(JSON.stringify(data));
      attemptedPosts.push(copied);
      const delivered = dispatch('message', { source: window, origin: targetOrigin || 'https://chatgpt.com', data: copied });
      if (delivered) {
        const visible = { ...copied };
        delete visible.usageObserverVersion;
        posts.push(visible);
      }
    },
    addEventListener: (type: string, handler: (event: any) => void, options?: { once?: boolean; capture?: boolean } | boolean) => {
      const rows = listeners.get(type) ?? [];
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      if (!rows.some(row => row.handler === handler && row.capture === capture))
        rows.push({ handler, once: typeof options === 'object' && options?.once === true, capture });
      listeners.set(type, rows);
    },
    removeEventListener: (type: string, handler: (event: any) => void, options?: { capture?: boolean } | boolean) => {
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      listeners.set(type, (listeners.get(type) ?? []).filter(row => row.handler !== handler || row.capture !== capture));
    }
  };
  window.top = window;
  function dispatch(type: string, event: any) {
    let stopped = false;
    event.stopImmediatePropagation ??= () => { stopped = true; };
    const rows = [...(listeners.get(type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const row of rows) {
      if (stopped) break;
      row.handler(event);
    }
    const once = new Set(rows.filter(row => row.once).map(row => row.handler));
    if (once.size) listeners.set(type, (listeners.get(type) ?? []).filter(row => !once.has(row.handler)));
    return !stopped;
  };
  const sandbox = { window, document, location: { origin: 'https://chatgpt.com', protocol: 'https:', pathname: '/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, URL, Date: Clock, TextDecoder, TextEncoder,
    ...(options.crypto === false ? {} : { crypto: webcrypto }),
    setTimeout: (run: () => void, ms: number) => { timers.set(++timerId, { at: now + ms, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id) };
  prepare?.(window);
  runInNewContext(script, sandbox);
  /**
   * The observer digests candidate ids with the page crypto API, so a shape publication
   * lands a couple of turns after its frame. Give those turns a bounded, generous window.
   */
  async function settleShapes() {
    for (let attempt = 0; attempt < 8; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  }
  async function feed(data: unknown, url = 'https://chatgpt.com/backend-api/wham/usage', init: Record<string, unknown> = {}) {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let read = false;
    const bodyGate = nextBodyGate; nextBodyGate = null;
    const body = new TextEncoder().encode(JSON.stringify(data));
    response = { url, ok: true, headers: { get: () => 'application/json' }, clone: () => ({ body: { getReader: () => ({
      read: async () => { await bodyGate; return read ? { done: true } : (read = true, { done: false, value: body }); },
      cancel: async () => { done(); }
    }) } }) };
    const expectedResponse = response;
    const returned = await window.fetch('/endpoint', { headers: { Authorization: 'private-test-value' }, ...init });
    expect(returned).toBe(expectedResponse);
    if (new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(wham\/usage|conversation\/init|conversation\/prepare|models)$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  async function feedSse(
    chunks: string[],
    init: Record<string, unknown> = { method: 'POST' },
    url = 'https://chatgpt.com/backend-api/conversation',
    overrides: { status?: number; redirected?: boolean; contentType?: string; ok?: boolean; requestInput?: unknown } = {}
  ) {
    response = {
      url,
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      redirected: overrides.redirected ?? false,
      headers: { get: () => overrides.contentType ?? 'text/event-stream; charset=utf-8' },
      // Each clone is an independent stream, exactly as a real Response.clone() is.
      clone: () => {
        let at = 0;
        return { body: { getReader: () => ({
          read: async () => {
            const gate = nextSseGate; nextSseGate = null;
            await gate;
            return at < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[at++]!) }
              : { done: true };
          },
          cancel: async () => undefined
        }) } };
      }
    };
    const returned = await window.fetch(overrides.requestInput ?? '/backend-api/conversation', init);
    expect(returned).toBe(response);
    await new Promise(resolve => setTimeout(resolve, 0));
    await settleShapes();
  }
  return {
    posts,
    attemptedPosts,
    nativeSocket: Socket,
    socket: (url = 'wss://ws.chatgpt.com/ws') => new window.WebSocket(url),
    feed,
    feedSse,
    settleShapes,
    hide: () => dispatch('pagehide', {}),
    replaceFetch: (wrapExisting = false) => {
      const previous = window.fetch;
      const replacement = (...args: unknown[]) => wrapExisting ? previous(...args) : Promise.resolve(response);
      window.fetch = replacement;
      return replacement;
    },
    ready: () => { document.readyState = 'interactive'; dispatch('DOMContentLoaded', {}); },
    currentFetch: () => window.fetch,
    holdNextBody: () => { let release = () => {}; nextBodyGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); },
    holdNextSseChunk: () => { let release = () => {}; nextSseGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); },
    advance: (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    request: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-usage-request' } }),
    shapeRequest: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-request-shape-request' } }),
    reattach: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-usage-reattach' } }),
    setPathname: (pathname: string) => { sandbox.location.pathname = pathname; },
    rerun: (version?: number) => runInNewContext(version
      ? script.replace('const OBSERVER_VERSION = 7;', `const OBSERVER_VERSION = ${version};`)
      : script, sandbox),
    observerState: () => window.__cosUsageObserverState,
    messageListenerCount: () => listeners.get('message')?.length ?? 0,
    legacyPost: (data: Record<string, unknown>) => window.postMessage(data, 'https://chatgpt.com'),
    currentWebSocket: () => window.WebSocket
  };
}

describe('MAIN-world usage projection', () => {
  it('rejects every synthetic stream metadata shape as request ownership evidence', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const b = '11111111-2222-4333-8444-555555555555';
    const unsupported = [
      { conversation_id: a, metadata: { request_id: 'wfr_root_snake' } },
      { conversation_id: a, metadata: { requestId: 'wfr_root_camel' } },
      { conversation_id: a, message: { metadata: { request_id: 'wfr_message_snake' } } },
      { conversation_id: a, message: { metadata: { requestId: 'wfr_message_camel' } } },
      { conversation_id: a, message: { author: { role: 'tool' }, metadata: { request_id: 'wfr_tool_snake' } } },
      { conversation_id: a, message: { author: { role: 'tool' }, metadata: { requestId: 'wfr_tool_camel' } } },
      { conversation_id: a, message: { author: { role: 'user' }, metadata: { request_id: 'wfr_user_snake' } } },
      { conversation_id: a, message: { author: { role: 'user' }, metadata: { requestId: 'wfr_user_camel' } } },
      { conversation_id: a, message: { author: { role: 'unknown' }, metadata: { request_id: 'wfr_unknown_author' } } },
      { conversation_id: a, message: { metadata: { request_id: 'wfr_missing_author' } } },
      { conversation_id: a, tool_output: { metadata: { requestId: 'wfr_tool_output' } } },
      { conversation_id: a, args: { metadata: { request_id: 'wfr_args' } } },
      { conversation_id: a, results: { metadata: { requestId: 'wfr_results' } } },
      { conversation_id: a, content: { metadata: { request_id: 'wfr_content' } } },
      { conversation_id: a, payload: { message: { metadata: { requestId: 'wfr_payload' } } } },
      { conversation_id: a, nested: { conversation_id: b, metadata: { request_id: 'wfr_descendant' } } },
      { conversation_id: a, message: { conversation_id: b, metadata: { request_id: 'wfr_contradiction' } } }
    ];
    for (const event of unsupported) await h.feedSse([`data: ${JSON.stringify(event)}\n\n`]);
    const frame = `data: ${JSON.stringify({ conversation_id: a, message: { metadata: { request_id: 'wfr_socket_synthetic' } } })}\n\n`;
    h.socket().receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id: a, encoded_item: frame
    } } }]);
    expect(h.posts.filter(post => post.type === 'cos-request-origin')).toEqual([]);
    // The same traffic is captured as diagnostic structure, which is what this observer
    // is allowed to publish; ownership remains zero.
    expect(h.posts.some(post => post.type === 'cos-request-shape')).toBe(true);
  });
  it('replaces the stale boolean observer guard and drops request-origin messages', () => {
    const h = harness(page => { page.__cosUsageObserver = true; });
    h.legacyPost({ type: 'cos-request-origin', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestIds: ['wfr_legacy'] });
    expect(h.observerState().version).toBe(7);
    expect(h.messageListenerCount()).toBe(1);
    expect(h.posts).toEqual([]);
  });
  it('reattaches usage observation after fetch is replaced once the page is ready', async () => {
    const h = harness();
    h.ready();
    const replacement = h.replaceFetch();
    h.reattach();
    expect(h.currentFetch()).not.toBe(replacement);
    await h.feed({ limits_progress: [{ model_slug: 'after-ready', remaining: 2 }] });
    expect(h.posts).toEqual([{ type: 'cos-usage', rows: [expect.objectContaining({ model: 'after-ready', remaining: 2 })], observedAt: expect.any(Number) }]);
  });
  it('does not install a second observer when the current version is injected again', () => {
    const h = harness();
    const currentFetch = h.currentFetch();
    h.rerun();
    expect(h.currentFetch()).toBe(currentFetch);
    expect(h.messageListenerCount()).toBe(1);
    expect(h.observerState().version).toBe(7);
  });
  it('retires replaceable observers before a future-version reinstall', () => {
    const h = harness();
    for (const version of [8, 9]) {
      h.rerun(version);
      expect(h.observerState().version).toBe(version);
      expect(h.messageListenerCount()).toBe(1);
      h.legacyPost({ type: 'cos-request-origin', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestIds: ['wfr_old'] });
      expect(h.posts).toEqual([]);
    }
  });
  it('quarantines an unreplaceable legacy publisher before it can answer a reattach request', () => {
    const h = harness(page => {
      page.__cosUsageObserver = true;
      page.addEventListener('message', (event: any) => {
        if (event.data?.type === 'cos-usage-request')
          page.postMessage({ type: 'cos-request-origin', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestIds: ['wfr_legacy'] }, event.origin);
      });
    });
    h.request();
    expect(h.attemptedPosts.filter(post => post.type === 'cos-request-origin')).toEqual([]);
    expect(h.posts).toEqual([]);
  });
  it('retains supported model counts without requiring a reset timestamp', async () => {
    const h = harness();
    await h.feed({ model_limits: [{ model_slug: 'model-a', remaining: 3 }, { model_slug: 'model-b', remaining: 0, resets_after: 'invalid' }, { model_slug: 'unknown' }] });
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'model-a', remaining: 3, resetAt: null }),
      expect.objectContaining({ model: 'model-b', remaining: 0, resetAt: null })
    ]);
  });
  it('rejects an older response completing after a newer recognized snapshot, even within one millisecond', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'old-model', remaining: 3 }] });
    await h.feed({ limits_progress: [] });
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.rows).toEqual([]);
    h.request();
    expect(h.posts[1]?.rows).toEqual([]);
  });
  it('preserves invocation time and does not let unrelated newer responses suppress quota evidence', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'model-a', remaining: 3 }] });
    h.advance(2000);
    await h.feed({ models: [] }, 'https://chatgpt.com/backend-api/models');
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.observedAt).toBe(Date.parse('2026-09-05T12:00:00Z'));
  });
  it('projects shared percentage windows without copying credentials or inventing a model balance', async () => {
    const h = harness();
    await h.feed({ access_token: 'secret', email: 'private@example.test', rate_limit: { primary_window: { used_percent: 25, reset_at: 1900000000, limit_window_seconds: 18000 } } });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [{ model: 'Shared usage', scope: 'shared', remaining: null, remainingPercent: 75, resetAt: 1900000000000, windowSeconds: 18000 }] }]);
    expect(JSON.stringify(h.posts)).not.toMatch(/secret|private|Authorization/);
  });

  it('keeps model and feature evidence separate', async () => {
    const h = harness();
    await h.feed({ conversation_detail_metadata: { limits_progress: [{ feature_name: 'deep-research', remaining: 5 }, { model_slug: 'gpt-example', remaining: 2 }], model_limits: [{ model_slug: 'gpt-exhausted', resets_after: '2030-01-01T00:00:00Z' }] } }, 'https://chatgpt.com/backend-api/conversation/init');
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'gpt-exhausted', scope: 'model', remaining: null }),
      expect.objectContaining({ model: 'deep-research', scope: 'feature', remaining: 5 }),
      expect.objectContaining({ model: 'gpt-example', scope: 'model', remaining: 2 })
    ]);
  });

  it('ignores foreign and unrelated responses, invalid counts and oversized payloads', async () => {
    const h = harness();
    const valid = { rate_limit: { primary_window: { used_percent: 20 } } };
    await h.feed(valid, 'https://example.test/backend-api/wham/usage');
    await h.feed(valid, 'https://chatgpt.com/backend-api/conversations');
    await h.feed({ limits_progress: [{ model_slug: 'gpt-example', remaining: -2 }, { model_slug: 'gpt-other', remaining: '3' }], rate_limit: { primary_window: { used_percent: 101 } } });
    await h.feed({ ...valid, padding: 'x'.repeat(513 * 1024) });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('does not emit zero reset timestamps or durations rejected by the app schema', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20, reset_at: 0, limit_window_seconds: 0 } } });
    expect(h.posts[0]?.rows[0]).toMatchObject({ remainingPercent: 80, resetAt: null, windowSeconds: null });
  });

  it('only replays to an exact same-page request', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20 } } });
    h.request({}, 'https://chatgpt.com');
    h.request(undefined, 'https://example.test');
    expect(h.posts).toHaveLength(1);
    h.advance(600000);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.observedAt).toBe(h.posts[0]?.observedAt);
  });

  it('emits an empty recognized quota snapshot but abstains on unrelated model metadata', async () => {
    const h = harness();
    await h.feed({ models: [{ slug: 'gpt-example', title: 'Example', max_tokens: 100000 }] }, 'https://chatgpt.com/backend-api/models');
    expect(h.posts).toEqual([]);
    await h.feed({ conversation_detail_metadata: { model_limits: [], limits_progress: [] } }, 'https://chatgpt.com/backend-api/conversation/prepare');
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('bounds the complete projection and rejects labels that could carry private or executable text', async () => {
    const h = harness();
    await h.feed({ limits_progress: [{ model_slug: 'private@example.test', remaining: 3 }, { feature_name: '<script>secret</script>', remaining: 5 }] });
    expect(h.posts[0]?.rows).toEqual([]);
    await h.feed({
      model_limits: Array.from({ length: 45 }, (_, i) => ({ model_slug: `model-${i}`, resets_after: '2030-01-01T00:00:00Z' })),
      limits_progress: Array.from({ length: 45 }, (_, i) => ({ feature_name: `feature-${i}`, remaining: 3 })),
      rate_limit: { primary_window: { used_percent: 20 } }
    });
    expect(h.posts[1]?.rows).toHaveLength(80);
    expect(JSON.stringify(h.posts)).not.toMatch(/private@example|<script>/);
  });

  it('reattaches after the page runtime replaces fetch during startup', async () => {
    const h = harness();
    const replacement = h.replaceFetch();
    expect(h.currentFetch()).toBe(replacement);
    h.ready();
    expect(h.currentFetch()).not.toBe(replacement);
    await h.feed({ limits_progress: [{ model_slug: 'after-startup', remaining: 3 }] });
    expect(h.posts).toEqual([{ type: 'cos-usage', rows: [expect.objectContaining({ model: 'after-startup', remaining: 3 })], observedAt: expect.any(Number) }]);
  });

  it('preserves a page wrapper that delegates to the earlier observer without recursion or duplicate inspection', async () => {
    const h = harness();
    h.replaceFetch(true);
    h.ready();
    await h.feed({ limits_progress: [{ model_slug: 'wrapped-fetch', remaining: 4 }] });
    expect(h.posts).toEqual([{ type: 'cos-usage', rows: [expect.objectContaining({ model: 'wrapped-fetch', remaining: 4 })], observedAt: expect.any(Number) }]);
  });
});

describe('MAIN-world request-shape diagnostic', () => {
  const CONVERSATION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER = '11111111-2222-4333-8444-555555555555';
  const shapePosts = (h: ReturnType<typeof harness>) => h.posts.filter(post => post.type === 'cos-request-shape');
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const socketRows = (event: unknown, conversationId = CONVERSATION) => ([{
    type: 'message',
    payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id: conversationId, encoded_item: frame(event)
    } }
  }]);

  it('records the request-id path, conversation identity and author enum for both transports', async () => {
    const h = harness();
    const event = {
      conversation_id: CONVERSATION,
      message: { author: { role: 'assistant' }, metadata: { request_id: 'wfr_live_shape_probe' } }
    };
    await h.feedSse([frame(event)]);
    expect(shapePosts(h).find(post => post.transport === 'sse')).toMatchObject({
      endpoint: 'conversation-direct-transport',
      envelope: ['root'],
      requestPaths: ['message.metadata.request_id'],
      requestStyle: 'snake',
      conversationPaths: ['conversation_id'],
      conversationValid: true,
      conversationConsistent: true,
      conversationMatch: true,
      author: 'assistant',
      scope: 'message',
      occurrences: 1
    });
    h.socket().receive(socketRows(event));
    await h.settleShapes();
    expect(shapePosts(h).find(post => post.transport === 'socket')).toMatchObject({
      endpoint: 'socket',
      envelope: ['message', 'conversation-turn-stream', 'stream-item'],
      requestPaths: ['message.metadata.request_id'],
      requestStyle: 'snake',
      conversationPaths: ['conversation_id'],
      conversationValid: true,
      conversationConsistent: true,
      conversationMatch: true,
      author: 'assistant',
      scope: 'message'
    });
    // No ownership message, no raw identifier and no authored value anywhere in the output.
    expect(h.posts.filter(post => post.type === 'cos-request-origin')).toEqual([]);
    expect(JSON.stringify(h.posts)).not.toContain('wfr_live_shape_probe');
    expect(JSON.stringify(h.posts)).not.toContain(CONVERSATION);
  });

  it('records camelCase ids, conversation disagreement and never copies payload contents', async () => {
    const h = harness();
    const secret = 'AUTHORED_PROSE_9f2c';
    const event = {
      conversation_id: OTHER,
      message: {
        author: { role: 'tool' },
        metadata: { requestId: 'wfr_camel_case_id' },
        content: { content_type: 'text', text: secret, parts: [secret] },
        tool_arguments: { request_id: secret },
        result: { conversation_id: CONVERSATION, requestId: secret }
      }
    };
    await h.feedSse([frame(event)]);
    expect(shapePosts(h)[0]).toMatchObject({
      requestPaths: ['message.metadata.requestId'],
      requestStyle: 'camel',
      conversationPaths: ['conversation_id'],
      conversationValid: true,
      conversationConsistent: true,
      conversationMatch: false,
      author: 'tool',
      scope: 'message'
    });
    expect(shapePosts(h)[0]?.requestPaths).toEqual(['message.metadata.requestId']);
    expect(JSON.stringify(h.posts)).not.toContain(secret);
  });

  it('records an array request-id path without copying its entries', async () => {
    const h = harness();
    const secret = 'wfr_array_entry_value';
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_ids: [secret] } })]);
    expect(shapePosts(h)[0]).toMatchObject({ requestPaths: ['metadata.request_ids'], scope: 'metadata', requestStyle: 'snake' });
    expect(JSON.stringify(h.posts)).not.toContain(secret);
  });

  it('bounds scanned events, retained shapes and socket envelopes', async () => {
    const h = harness();
    const frames = Array.from({ length: 200 }, (_, index) =>
      frame({ conversation_id: CONVERSATION, metadata: { request_id: `wfr_count_${index}` } }));
    await h.feedSse(frames);
    const posts = shapePosts(h);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(24);
    expect(Math.max(...posts.map(post => post.occurrences))).toBeLessThanOrEqual(128);
    const before = shapePosts(h).length;
    h.socket().receive(Array.from({ length: 25 }, () => socketRows({ metadata: { request_id: 'wfr_row_cap' } })[0]));
    await h.settleShapes();
    expect(shapePosts(h).length).toBe(before);
  });

  it('ignores foreign, malformed and unsupported stream traffic', async () => {
    const h = harness();
    const event = { conversation_id: CONVERSATION, metadata: { request_id: 'wfr_ignored' } };
    await h.feedSse([frame(event)], { method: 'POST' }, 'https://example.test/backend-api/conversation');
    await h.feed({ metadata: { request_id: 'wfr_json_body' } }, 'https://chatgpt.com/backend-api/conversation');
    await h.feedSse(['data: {not json}\n\n', frame({ conversation_id: CONVERSATION }), 'event: ping\n\n']);
    h.socket('wss://example.test/ws').receive(socketRows(event));
    for (const event2 of [null, 'text', 7, { conversation_id: CONVERSATION, metadata: { request_id: '' } }]) {
      h.socket().receive(socketRows(event2));
    }
    await tick();
    await h.settleShapes();
    expect(shapePosts(h)).toEqual([]);
    // A replay request from a foreign origin is not answered either.
    h.shapeRequest(undefined, 'https://example.test');
    expect(shapePosts(h)).toEqual([]);
  });

  it('cancels stream readers and socket listeners when the observer generation is disposed', async () => {
    const h = harness();
    const release = h.holdNextSseChunk();
    const pending = h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: 'wfr_disposed' } })]);
    await tick();
    const socket = h.socket();
    h.observerState().dispose();
    release();
    await pending;
    socket.receive(socketRows({ metadata: { request_id: 'wfr_after_dispose' } }));
    await tick();
    expect(shapePosts(h)).toEqual([]);
  });

  it('replays retained shapes only when the page explicitly asks for them', async () => {
    const h = harness();
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: 'wfr_replay' } })]);
    const count = shapePosts(h).length;
    expect(count).toBe(1);
    h.request();
    expect(shapePosts(h)).toHaveLength(count);
    h.shapeRequest();
    expect(shapePosts(h)).toHaveLength(count + 1);
    expect(shapePosts(h).at(-1)).toMatchObject({ requestPaths: ['metadata.request_id'], conversationMatch: true });
  });

  it('matches conversation identity only against the current route', async () => {
    const h = harness();
    h.setPathname('/');
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: 'wfr_route_unknown' } })]);
    expect(shapePosts(h).at(-1)).toMatchObject({ conversationMatch: null, conversationConsistent: true });
    h.setPathname(`/c/${OTHER}`);
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: 'wfr_route_other' } })]);
    expect(shapePosts(h).at(-1)).toMatchObject({ conversationMatch: false });
    h.setPathname(`/c/${CONVERSATION}`);
    h.socket().receive(socketRows({ conversation_id: OTHER, metadata: { request_id: 'wfr_outer_inner' } }, CONVERSATION));
    await h.settleShapes();
    expect(shapePosts(h).find(post => post.transport === 'socket')).toMatchObject({
      conversationPaths: ['conversation_id'],
      // The envelope carries the route conversation id (match) while its inner frame
      // names a different one (not consistent); both facts are reported separately.
      conversationConsistent: false,
      conversationMatch: true
    });
  });

  it('derives one path-tied SHA-256 digest per candidate and never publishes the raw id', async () => {
    const h = harness();
    const raw = 'wfr_live_digest_probe_01';
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: raw } })]);
    const post = shapePosts(h).at(-1);
    expect(post?.fingerprints).toEqual([{ path: 'metadata.request_id', digest: sha256(raw) }]);
    expect(post?.fingerprints[0].digest).not.toBe(raw);
    expect(JSON.stringify(h.posts)).not.toContain(raw);
    // A digest is not an ownership message; the observer still publishes nothing that
    // could open a correlation or handshake.
    expect(h.posts.filter(entry => entry.type === 'cos-request-origin')).toEqual([]);
  });

  it('keeps the two live request paths as independent fingerprint evidence', async () => {
    const h = harness();
    const inputId = 'wfr_input_message_probe';
    const messageId = 'wfr_message_probe';
    await h.feedSse([
      frame({ conversation_id: CONVERSATION, input_message: { metadata: { request_id: inputId } } }),
      frame({ conversation_id: CONVERSATION, message: { author: { role: 'assistant' }, metadata: { request_id: messageId } } })
    ]);
    const input = shapePosts(h).find(post => post.requestPaths?.includes('input_message.metadata.request_id'));
    const message = shapePosts(h).find(post => post.requestPaths?.includes('message.metadata.request_id'));
    expect(input?.fingerprints).toEqual([{ path: 'input_message.metadata.request_id', digest: sha256(inputId) }]);
    expect(message?.fingerprints).toEqual([{ path: 'message.metadata.request_id', digest: sha256(messageId) }]);
    expect(JSON.stringify(h.posts)).not.toContain(inputId);
    expect(JSON.stringify(h.posts)).not.toContain(messageId);
  });

  it('accumulates recent distinct fingerprints and publishes a suppressed change after the interval', async () => {
    const h = harness();
    const first = 'wfr_fingerprint_first';
    const second = 'wfr_fingerprint_second';
    const third = 'wfr_fingerprint_third';
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: first } })]);
    expect(shapePosts(h)).toHaveLength(1);
    // Occurrence 2 is an existing publication checkpoint.
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: second } })]);
    expect(shapePosts(h)).toHaveLength(2);
    expect(shapePosts(h).at(-1)?.fingerprints).toEqual([
      { path: 'metadata.request_id', digest: sha256(first) },
      { path: 'metadata.request_id', digest: sha256(second) }
    ]);
    // Occurrence 3 changes the set inside the interval: retained, not yet published.
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: third } })]);
    expect(shapePosts(h)).toHaveLength(2);
    h.advance(2000);
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: third } })]);
    expect(shapePosts(h)).toHaveLength(3);
    expect(shapePosts(h).at(-1)?.fingerprints).toEqual([
      { path: 'metadata.request_id', digest: sha256(first) },
      { path: 'metadata.request_id', digest: sha256(second) },
      { path: 'metadata.request_id', digest: sha256(third) }
    ]);
  });

  it('still publishes structural shapes without fingerprints when page crypto is unavailable', async () => {
    const h = harness(undefined, { crypto: false });
    const raw = 'wfr_without_crypto';
    await h.feedSse([frame({ conversation_id: CONVERSATION, metadata: { request_id: raw } })]);
    expect(shapePosts(h).at(-1)).toMatchObject({ requestPaths: ['metadata.request_id'], fingerprints: [] });
    expect(JSON.stringify(h.posts)).not.toContain(raw);
    expect(h.posts.filter(entry => entry.type === 'cos-request-origin')).toEqual([]);
  });

  // ------------------------------------------------------------------ direct-A production evidence

  const directPosts = (h: ReturnType<typeof harness>) => h.posts.filter(post => post.type === 'cos-request-origin-direct');
  const directEndPosts = (h: ReturnType<typeof harness>) => h.posts.filter(post => post.type === 'cos-request-origin-direct-end');
  const directFrame = (requestId: string, overrides: Record<string, unknown> = {}) => frame({
    conversation_id: CONVERSATION,
    input_message: {
      author: { role: 'user' },
      metadata: { request_id: requestId },
      ...overrides
    }
  });

  it('publishes the exact direct-A request id under the full transport and envelope gate', async () => {
    const h = harness();
    const requestId = 'wfr_direct_exact_01';
    await h.feedSse([directFrame(requestId)]);
    expect(directPosts(h)).toEqual([expect.objectContaining({
      requestId,
      conversationId: CONVERSATION,
      observedAt: expect.any(Number)
    })]);
    expect(directEndPosts(h)).toEqual([expect.objectContaining({
      requestId,
      conversationId: CONVERSATION,
      observedAt: expect.any(Number)
    })]);
    // Diagnostics still observe the same frame independently.
    expect(shapePosts(h).some(post => post.requestPaths.includes('input_message.metadata.request_id'))).toBe(true);
    // A repeated frame is one candidate; usage/shape replays never republish it as ownership.
    await h.feedSse([directFrame(requestId)]);
    expect(directPosts(h)).toHaveLength(1);
    h.request();
    h.shapeRequest();
    expect(directPosts(h)).toHaveLength(1);
  });

  it('accepts the exact /backend-api/f/conversation migration route without broadening to adjacent variants', async () => {
    const h = harness();
    const requestId = 'wfr_direct_f_route_01';
    await h.feedSse([directFrame(requestId)], { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(directPosts(h)).toEqual([expect.objectContaining({ requestId, conversationId: CONVERSATION })]);
    await h.feedSse([directFrame('wfr_direct_f_prepare')], { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation/prepare');
    expect(directPosts(h)).toHaveLength(1);
  });

  it('rejects every direct-A frame that is not the exact approved envelope', async () => {
    const h = harness();
    const requestId = 'wfr_direct_reject_01';
    const route = CONVERSATION;
    const notExact: Array<[string, unknown]> = [
      // The B envelope and its author variants never carry direct-A authority.
      ['v.message path', { conversation_id: route, v: { message: { author: { role: 'user' }, metadata: { request_id: requestId } } } }],
      ['assistant author', { conversation_id: route, input_message: { author: { role: 'assistant' }, metadata: { request_id: requestId } } }],
      ['system author', { conversation_id: route, input_message: { author: { role: 'system' }, metadata: { request_id: requestId } } }],
      ['tool author', { conversation_id: route, input_message: { author: { role: 'tool' }, metadata: { request_id: requestId } } }],
      ['missing author', { conversation_id: route, input_message: { metadata: { request_id: requestId } } }],
      // User-controlled payload and arbitrary descendants cannot smuggle a request id in.
      ['content payload', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: {}, content: { parts: [{ text: `{"request_id":"${requestId}"}` }] } } }],
      ['nested metadata', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: { nested: { request_id: requestId } } } }],
      ['deep descendant', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: { a: { b: { request_id: requestId } } } } }],
      // Only the exact snake_case metadata path on input_message is recognized.
      ['camelCase', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: { requestId: requestId } } }],
      ['root metadata', { conversation_id: route, metadata: { request_id: requestId }, input_message: { author: { role: 'user' } } }],
      ['array ids', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: { request_id: [requestId, requestId] } } }],
      ['object ids', { conversation_id: route, input_message: { author: { role: 'user' }, metadata: { request_id: { value: requestId } } } }],
      ['malformed conversation', { conversation_id: 'not-a-uuid', input_message: { author: { role: 'user' }, metadata: { request_id: requestId } } }],
      ['missing conversation', { input_message: { author: { role: 'user' }, metadata: { request_id: requestId } } }],
      // A contradictory recognized envelope-level conversation identity fails the frame.
      ['contradictory conversation', { conversation_id: route, input_message: { conversation_id: OTHER, author: { role: 'user' }, metadata: { request_id: requestId } } }]
    ];
    for (const [, event] of notExact) await h.feedSse([frame(event)]);
    expect(directPosts(h), notExact.map(([entry]) => entry).join(', ')).toEqual([]);
  });

  it('rejects a direct-A frame when the route names another conversation', async () => {
    const h = harness();
    h.setPathname(`/c/${OTHER}`);
    await h.feedSse([directFrame('wfr_direct_route_wrong')]);
    expect(directPosts(h)).toEqual([]);
    h.setPathname(`/c/${CONVERSATION}`);
    await h.feedSse([directFrame('wfr_direct_route_right')]);
    expect(directPosts(h)).toHaveLength(1);
  });

  it('rejects every direct-A transport that is not the exact approved response', async () => {
    const h = harness();
    const requestId = 'wfr_direct_transport_01';
    const file = [directFrame(requestId)];
    await h.feedSse(file, { method: 'GET' });
    // Fetch RequestInit overrides a Request object's method. The ownership gate must observe
    // the effective GET, not the Request's original POST.
    await h.feedSse(file, { method: 'GET' }, 'https://chatgpt.com/backend-api/conversation', {
      requestInput: { method: 'POST' }
    });
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation/stream');
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation-turn');
    await h.feedSse(file, { method: 'POST' }, 'https://example.test/backend-api/conversation');
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { status: 201 });
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { status: 204 });
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { redirected: true });
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { contentType: 'application/json' });
    // Substring matching must not pass: the media type is compared exactly.
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { contentType: 'text/event-stream+json' });
    await h.feedSse(file, { method: 'POST' }, 'https://chatgpt.com/backend-api/conversation', { contentType: 'application/text-event-stream' });
    expect(directPosts(h)).toEqual([]);
    expect(directEndPosts(h)).toEqual([]);
    // The exact response passes, proving the rejections above were the gate and not a fixture.
    await h.feedSse(file);
    expect(directPosts(h)).toHaveLength(1);
    expect(directEndPosts(h)).toHaveLength(1);
  });

  it('fails direct-A closed when envelope consistency exceeds the bounded inspection budget', async () => {
    const h = harness();
    const requestId = 'wfr_direct_bounded_conflict';
    const event: Record<string, unknown> = {
      conversation_id: CONVERSATION,
      input_message: { author: { role: 'user' }, metadata: { request_id: requestId } }
    };
    // The old `slice(0, 32)` implementation silently ignored this recognized contradiction.
    // Hitting the ownership walk's safety bound is now rejection, never positive agreement.
    for (let index = 0; index < 32; index++) event[`filler_${index}`] = { value: index };
    event.conversationId = OTHER;
    await h.feedSse([frame(event)]);
    expect(directPosts(h)).toEqual([]);
  });

  it('never publishes direct-A evidence from the socket transport or a JSON body', async () => {
    const h = harness();
    const requestId = 'wfr_direct_socket_01';
    h.socket().receive(socketRows({
      conversation_id: CONVERSATION,
      input_message: { author: { role: 'user' }, metadata: { request_id: requestId } }
    }));
    await h.settleShapes();
    expect(shapePosts(h).some(post => post.transport === 'socket')).toBe(true);
    expect(directPosts(h)).toEqual([]);
  });
});
