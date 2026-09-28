/**
 * Passive, bounded MAIN-world observation.
 *
 * Two read-only projections cross into the isolated world:
 *  - `cos-usage`: account quota metadata from allowlisted JSON responses.
 *  - `cos-request-shape`: the *structure* of provider request envelopes — transport,
 *    endpoint class, envelope type names, the exact JSON property paths that hold a
 *    request-like id, id casing, conversation-path presence/agreement and an author role
 *    enum. A shape record never carries a request id, conversation id, header, body,
 *    authored text, tool argument, tool result or raw metadata value.
 *
 * Where the page crypto API is available a shape also carries one SHA-256 digest per bounded
 * candidate request id, tied to the property path it came from. The digest is internal
 * diagnostic carriage for an exact-equality test against a recent inbound MCP request id;
 * the raw id never leaves this observer, and the app discards the digest before storing or
 * rendering companion diagnostics.
 *
 * One production observation exists separately from the shapes: `cos-request-origin-direct`.
 * It is published only for a successful, unredirected, same-origin HTTPS ChatGPT
 * `/backend-api/conversation` or `/backend-api/f/conversation` POST whose parsed
 * `text/event-stream` frame carries the exact
 * `input_message.metadata.request_id` under a valid root `conversation_id` that equals the
 * current `/c/<id>` route, with `input_message.author.role === 'user'`. It carries that one
 * scalar id and conversation id — matching evidence the app may use only after exact equality
 * with a real normalized inbound MCP `x-request-id`. Shapes never feed it and it never feeds
 * a shape.
 *
 * Never reads request headers, cookies, credentials or request bodies. It clones responses
 * and never mutates a page request.
 */
(() => {
  'use strict';
  // Bump when the hooks change. A boolean leftover from an
  // older MAIN-world copy must not count as current: Chrome does not rerun this
  // document_start script in an already-open tab, and that leftover used to block
  // a later injection from refreshing observation.
  const OBSERVER_VERSION = 7;
  // Same manifest version can carry a locally dogfooded observer repair. Keep this separate
  // from the wire version so background/content compatibility remains unchanged while an
  // explicit MAIN-world reinjection can still retire the older implementation in-place.
  const OBSERVER_REVISION = 3;
  const priorObserver = window.__cosUsageObserverState;
  if (priorObserver && priorObserver.version === OBSERVER_VERSION && priorObserver.revision === OBSERVER_REVISION &&
      typeof priorObserver.reattach === 'function') {
    priorObserver.reattach();
    return;
  }
  const legacyObserver = Boolean(priorObserver?.legacyQuarantined || (!priorObserver && window.__cosUsageObserver));
  if (priorObserver && typeof priorObserver.dispose === 'function') {
    try { priorObserver.dispose(); } catch { /* The replacement below is still the only useful recovery action. */ }
  }
  const post = window.postMessage.bind(window);
  let disposed = false;
  let messageListenerAttached = false;
  let latest = null;
  let requestOrder = 0, latestOrder = 0;
  const activeReaders = new Map();
  const fetchWrappers = [];
  function cancelReaders() {
    for (const [reader, state] of activeReaders) {
      clearTimeout(state.timer);
      void reader.cancel().catch(() => {});
    }
    activeReaders.clear();
  }
  function publish(data) {
    if (disposed) return;
    // The old observer captured postMessage without tagging its output and has no disposer.
    // The capture listener below drops those legacy publications while allowing only this
    // observer generation through to content.js.
    post({ ...data, usageObserverVersion: OBSERVER_VERSION }, location.origin);
  }
  const project = (data, observedAt, order) => {
    if (disposed || !data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; publish(latest);
  };
  async function inspect(response, observedAt, order) {
    if (disposed) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    activeReaders.set(reader, { timer });
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (!disposed) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      if (!disposed) project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); activeReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }

  /**
   * Diagnostic-only request-envelope shapes.
   *
   * A shape is structural: which transport carried it, which endpoint class, which envelope
   * type names, at which JSON property paths a request-like id sits, whether that id is
   * snake_case or camelCase, which conversation-path keys exist, whether the conversation
   * ids found in one envelope agree and whether they name the current route conversation,
   * the author role enum, the top-level container of the request path, and a bounded
   * occurrence count. No id, value, header, body or payload crosses this boundary.
   *
   * For candidate request ids the shape also carries a one-way SHA-256 digest per bounded
   * opaque id, tied to its path. The digest exists only so the app can test exact equality
   * against a recent inbound MCP request id; it is discarded there before storage/render,
   * and the raw id never leaves this function.
   */
  const SHAPE_REQUEST_KEY = /^(?:request_id|requestId|request_ids)$/;
  const SHAPE_CONVERSATION_KEY = /^(?:conversation_id|conversationId)$/;
  const SHAPE_OPAQUE_ID = /^[A-Za-z0-9_-]{1,100}$/;
  const SHAPE_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SHAPE_DIGEST = /^[0-9a-f]{64}$/;
  // Property names are allowlisted by shape, never by meaning: an underscore/letter head,
  // no whitespace or prose punctuation, and a hard length bound.
  const SHAPE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;
  const SHAPE_ROLE = /^[a-z][a-z0-9_]{0,23}$/;
  const SHAPE_TYPE = /^[a-z][a-z0-9-]{0,39}$/;
  // Payload-bearing containers are named but never walked: authored text, tool arguments
  // and tool results stay out of the diagnostic entirely.
  const SHAPE_SKIP = new Set(['content', 'parts', 'text', 'tool_arguments', 'args', 'arguments', 'result', 'results', 'output', 'tool_output', 'encoded_item']);
  const SHAPE_MAX_SHAPES = 24;
  const SHAPE_MAX_EVENTS = 128;
  const SHAPE_MAX_CANDIDATES = 8;
  const SHAPE_MAX_FINGERPRINTS = 8;
  // A fingerprint change may publish at most this often per shape; the retained fingerprint
  // set accumulates across the interval, so a short burst is delayed, never lost.
  const SHAPE_FINGERPRINT_INTERVAL_MS = 1000;
  const SHAPE_MAX_BYTES = 512 * 1024;
  const SHAPE_MAX_FRAME = 512 * 1024;
  const SHAPE_MAX_SOCKET_BYTES = 512 * 1024;
  const SHAPE_MAX_SOCKET_ROWS = 24;
  const SHAPE_MAX_SOCKET_FRAMES = 16;
  const SHAPE_LISTEN_MS = 5 * 60_000;
  const SHAPE_PUBLISH_AT = new Set([2, 10, 100, 500]);
  const shapeRecords = new Map();
  const shapeReaders = new Map();
  function currentRouteConversationId() {
    try {
      const match = location.pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
      return match ? match[1] : null;
    } catch { return null; }
  }
  function shapeSignature(record) {
    return [record.transport, record.endpoint, record.envelope.join('>'), record.requestPaths.join(','),
      record.requestStyle || '', record.conversationPaths.join(','), String(record.conversationValid),
      String(record.conversationConsistent), String(record.conversationMatch), record.author || '',
      record.scope || ''].join('\u0000');
  }
  function fingerprintKey(fingerprints) {
    return fingerprints.map(entry => `${entry.path}\u0000${entry.digest}`).join('\u0001');
  }
  /** Newest bounded fingerprints win; an exact path+digest pair is retained once. */
  function mergeFingerprints(previous, incoming) {
    const merged = [];
    for (const entry of [...previous, ...incoming]) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.digest !== 'string' || !SHAPE_DIGEST.test(entry.digest)) continue;
      const at = merged.findIndex(row => row.path === entry.path && row.digest === entry.digest);
      if (at >= 0) merged.splice(at, 1);
      merged.push({ path: entry.path, digest: entry.digest });
    }
    return merged.slice(-SHAPE_MAX_FINGERPRINTS);
  }
  /**
   * SHA-256 of one bounded opaque candidate id, UTF-8, lowercase hex.
   *
   * Returns null when the page has no usable crypto: the shape is still published, just
   * without fingerprints, and the app treats it as having no comparable evidence.
   */
  async function digestCandidate(id) {
    try {
      const subtle = typeof crypto !== 'undefined' && crypto ? crypto.subtle : null;
      if (!subtle || typeof TextEncoder !== 'function') return null;
      const hash = await subtle.digest('SHA-256', new TextEncoder().encode(id));
      let hex = '';
      for (const byte of new Uint8Array(hash)) hex += byte.toString(16).padStart(2, '0');
      return SHAPE_DIGEST.test(hex) ? hex : null;
    } catch { return null; }
  }
  /**
   * The exact object that may cross the boundary. Built field by field so an internal
   * candidate id or bookkeeping value can never ride along on a spread.
   */
  function wireShape(record, observedAt) {
    return {
      transport: record.transport,
      endpoint: record.endpoint,
      envelope: record.envelope.slice(0, 4),
      requestPaths: record.requestPaths.slice(0, 8),
      requestStyle: record.requestStyle,
      conversationPaths: record.conversationPaths.slice(0, 4),
      conversationValid: record.conversationValid,
      conversationConsistent: record.conversationConsistent,
      conversationMatch: record.conversationMatch,
      author: record.author,
      scope: record.scope,
      fingerprints: record.fingerprints.map(entry => ({ path: entry.path, digest: entry.digest })),
      occurrences: record.occurrences,
      observedAt
    };
  }
  function publishShape(shape, incoming, observedAt) {
    if (disposed || !shape || shape.requestPaths.length === 0) return;
    const signature = shapeSignature(shape);
    const fingerprints = mergeFingerprints([], Array.isArray(incoming) ? incoming : []);
    const existing = shapeRecords.get(signature);
    if (existing) {
      existing.occurrences = Math.min(existing.occurrences + 1, 999);
      const merged = mergeFingerprints(existing.fingerprints, fingerprints);
      // Compare with what was last published, not the last observation: a change suppressed
      // by the interval must still publish once the interval allows it.
      const changed = fingerprintKey(merged) !== existing.publishedFingerprintKey;
      existing.fingerprints = merged;
      const due = changed && observedAt - existing.fingerprintPublishedAt >= SHAPE_FINGERPRINT_INTERVAL_MS;
      if (SHAPE_PUBLISH_AT.has(existing.occurrences) || due) {
        existing.fingerprintPublishedAt = observedAt;
        existing.publishedFingerprintKey = fingerprintKey(existing.fingerprints);
        publish({ type: 'cos-request-shape', ...wireShape(existing, observedAt) });
      }
      return;
    }
    if (shapeRecords.size >= SHAPE_MAX_SHAPES) shapeRecords.delete(shapeRecords.keys().next().value);
    const stored = { ...shape, fingerprints, occurrences: 1, fingerprintPublishedAt: observedAt,
      publishedFingerprintKey: fingerprintKey(fingerprints) };
    shapeRecords.set(signature, stored);
    publish({ type: 'cos-request-shape', ...wireShape(stored, observedAt) });
  }
  function replayShapes() {
    for (const record of shapeRecords.values()) publish({ type: 'cos-request-shape', ...wireShape(record, record.observedAt) });
  }
  /** Digest the bounded candidates, drop the raw ids, then publish the structural record. */
  async function publishShapeWithCandidates(shape, observedAt) {
    const fingerprints = [];
    for (const candidate of (Array.isArray(shape.candidates) ? shape.candidates : []).slice(0, SHAPE_MAX_CANDIDATES)) {
      if (!candidate || typeof candidate.path !== 'string' || typeof candidate.id !== 'string') continue;
      const digest = await digestCandidate(candidate.id);
      if (digest) fingerprints.push({ path: candidate.path, digest });
    }
    delete shape.candidates;
    publishShape(shape, fingerprints, observedAt);
  }
  function shapeScopeOf(path) {
    const head = path.split('.')[0];
    if (head === 'request_id' || head === 'requestId' || head === 'request_ids') return 'root';
    return SHAPE_KEY.test(head) ? head : null;
  }
  function shapeOf(event, transport, endpoint, envelope, outerConversationId) {
    if (!event || typeof event !== 'object') return null;
    const requestPaths = [], conversationPaths = [], conversations = [], candidates = [];
    let author = null, visited = 0;
    const walk = (node, path, depth) => {
      if (!node || typeof node !== 'object' || depth > 8 || visited++ > 256) return;
      if (Array.isArray(node)) {
        const limit = Math.min(node.length, 16);
        for (let at = 0; at < limit; at++) walk(node[at], path, depth + 1);
        return;
      }
      let entries;
      try { entries = Object.entries(node).slice(0, 64); } catch { return; }
      for (const [key, child] of entries) {
        if (!SHAPE_KEY.test(key)) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (SHAPE_REQUEST_KEY.test(key)) {
          // A request-like id may be a single opaque string or a bounded array of them. The
          // path is recorded from structure alone; only bounded opaque candidates are kept
          // for the digest step, and every one of them is dropped once digested.
          const ids = Array.isArray(child) ? child.slice(0, 8) : [child];
          let valid = 0;
          for (const id of ids) {
            if (typeof id !== 'string' || !SHAPE_OPAQUE_ID.test(id)) continue;
            valid += 1;
            if (candidates.length < SHAPE_MAX_CANDIDATES) candidates.push({ path: childPath, id });
          }
          if (valid > 0 && requestPaths.length < 8 && !requestPaths.includes(childPath)) requestPaths.push(childPath);
          continue;
        }
        if (SHAPE_CONVERSATION_KEY.test(key)) {
          if (typeof child === 'string' && SHAPE_CONVERSATION_ID.test(child)) {
            if (conversationPaths.length < 4 && !conversationPaths.includes(childPath)) conversationPaths.push(childPath);
            if (conversations.length < 8) conversations.push(child);
          }
          continue;
        }
        if (key === 'role' && author === null && (path === 'author' || path.endsWith('.author')) &&
            typeof child === 'string' && SHAPE_ROLE.test(child)) author = child;
        if (SHAPE_SKIP.has(key) || !child || typeof child !== 'object') continue;
        walk(child, childPath, depth + 1);
      }
    };
    walk(event, '', 0);
    if (requestPaths.length === 0) return null;
    const unique = new Set(conversations);
    const outer = typeof outerConversationId === 'string' && SHAPE_CONVERSATION_ID.test(outerConversationId)
      ? outerConversationId : null;
    if (outer) unique.add(outer);
    const route = currentRouteConversationId();
    return {
      transport,
      endpoint,
      envelope,
      requestPaths,
      requestStyle: /(?:^|\.)requestId$/.test(requestPaths[0]) ? 'camel' : 'snake',
      conversationPaths,
      conversationValid: unique.size > 0,
      conversationConsistent: unique.size === 0 ? null : unique.size === 1,
      conversationMatch: route === null || unique.size === 0 ? null : unique.has(route),
      author,
      scope: shapeScopeOf(requestPaths[0]),
      candidates
    };
  }
  /** One complete `data:` frame from either transport, or null. Never retains the frame. */
  function parseFrame(frame) {
    if (typeof frame !== 'string' || frame.length === 0 || frame.length > SHAPE_MAX_FRAME) return null;
    let data = '';
    for (const line of frame.split(/\r?\n/)) if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
  }
  function inspectShapeFrame(frame, transport, endpoint, envelope, outerConversationId) {
    const shape = shapeOf(parseFrame(frame), transport, endpoint, envelope, outerConversationId);
    if (shape) void publishShapeWithCandidates(shape, Date.now());
  }
  function cancelShapeReaders() {
    for (const [reader, state] of shapeReaders) {
      clearTimeout(state.timer);
      void reader.cancel().catch(() => {});
    }
    shapeReaders.clear();
  }
  /** Passive SSE structure scan of one cloned conversation response. */
  async function inspectRequestShapes(response, requestMethod) {
    if (disposed) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:[^/]+\/)*conversation(?:\/[^/?]+)*$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    if (shapeReaders.size >= 2) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), SHAPE_LISTEN_MS);
    shapeReaders.set(reader, { timer });
    const decoder = new TextDecoder();
    let bytes = 0, frames = 0, buffer = '';
    // Diagnostic only: preserve whether the live response passed the same *transport* facts
    // required by direct-A (method/status/redirect/path/media type/top-level document). The
    // request-id envelope still has to pass its separate exact parser below, and neither this
    // label nor any shape can grant ownership.
    const exactPath = DIRECT_ORIGIN_PATHS.has(url.pathname);
    const post = requestMethod === 'POST';
    const directTransport = post && response.status === 200 && response.redirected === false && exactPath &&
      exactMediaType(response, 'text/event-stream') && topLevelChatGptDocument();
    let pathKind = exactPath ? 'exact' : 'variant';
    if (url.pathname === '/backend-api/f/conversation') pathKind = 'f';
    else if (/^\/backend-api\/[^/]+\/conversation$/.test(url.pathname)) pathKind = 'prefix';
    else if (/^\/backend-api\/conversation\/[^/]+$/.test(url.pathname)) pathKind = 'suffix';
    else if (/^\/backend-api\/[^/]+\/conversation\/[^/]+$/.test(url.pathname)) pathKind = 'mixed';
    const endpoint = directTransport
      ? 'conversation-direct-transport'
      : `conversation-${pathKind}-${post ? 'post' : 'other'}`;
    const scan = (frame) => {
      if (frames++ >= SHAPE_MAX_EVENTS) return false;
      inspectShapeFrame(frame, 'sse', endpoint, ['root'], null);
      return true;
    };
    try {
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > SHAPE_MAX_BYTES) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          if (!scan(buffer.slice(0, split))) return;
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > SHAPE_MAX_FRAME || frames >= SHAPE_MAX_EVENTS) return;
      }
      if (!disposed && buffer.length) scan(buffer);
    } catch { /* A missing shape observation leaves ownership exactly as it was. */ }
    finally { clearTimeout(timer); shapeReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }

  /**
   * Production direct-A request-origin observation.
   *
   * The exact transport gate, checked before any body byte is read:
   *   top-level ChatGPT document · HTTPS · exact same-origin
   *   · POST · pathname exactly `/backend-api/conversation`
   *   · status exactly 200 · `response.redirected === false`
   *   · Content-Type media type exactly `text/event-stream` (parameters allowed)
   *
   * The exact envelope gate, per parsed JSON frame:
   *   root `conversation_id` is a valid UUID and equals the current `/c/<id>` route
   *   · every other recognized envelope-level conversation id agrees with it
   *   · exact object path `input_message.metadata.request_id` is one bounded scalar
   *   · `input_message.author.role` is exactly `'user'`
   *
   * Anything else fails closed. The published record is matching evidence only: the app may
   * record ownership for that id only after exact equality with a real normalized inbound MCP
   * `x-request-id`; a structural shape or a digest never enters this path.
   */
  // ChatGPT currently serves the same conversation SSE contract from two exact routes while
  // cohorts migrate between them. Keep this as an explicit allowlist: nearby prepare/stream/
  // turn routes remain diagnostics-only and cannot create ownership.
  const DIRECT_ORIGIN_PATHS = new Set(['/backend-api/conversation', '/backend-api/f/conversation']);
  const DIRECT_ORIGIN_MAX_EVENTS = 128;
  const DIRECT_ORIGIN_MAX_BYTES = 512 * 1024;
  const DIRECT_ORIGIN_MAX_FRAME = 512 * 1024;
  const DIRECT_ORIGIN_MAX_PUBLISHED = 32;
  const DIRECT_ORIGIN_LISTEN_MS = 5 * 60_000;
  const directOriginPublished = new Map();
  const directOriginEnded = new Map();
  const directOriginReaders = new Map();
  function topLevelChatGptDocument() {
    try { return window.top === window && location.protocol === 'https:'; } catch { return false; }
  }
  function exactMediaType(response, expected) {
    try {
      const value = response.headers.get('content-type');
      if (typeof value !== 'string') return false;
      return value.split(';', 1)[0].trim().toLowerCase() === expected;
    } catch { return false; }
  }
  /**
   * Every recognized envelope-level conversation identity must agree with the root.
   *
   * The walk stays in the envelope: payload containers are never entered, depth and visit
   * counts are bounded, and an absent/null conversation field is simply not an identity.
   * A recognized key holding anything but the root UUID fails the frame closed.
   */
  function directOriginConversationAgrees(frame, rootConversationId) {
    // Ownership does not recursively search arbitrary descendants. Check only the other
    // envelope-level conversation identities we have actually observed/recognized beside A:
    // a root camelCase alias and the live `v` update envelope used by B. Their presence can
    // veto A, but they can never provide A's ownership themselves.
    const v = frame?.v && typeof frame.v === 'object' && !Array.isArray(frame.v) ? frame.v : null;
    const input = frame?.input_message && typeof frame.input_message === 'object' && !Array.isArray(frame.input_message)
      ? frame.input_message : null;
    const recognized = [
      frame?.conversationId,
      input?.conversation_id, input?.conversationId,
      v?.conversation_id, v?.conversationId
    ];
    for (const child of recognized) {
      if (child === null || child === undefined || child === '') continue;
      if (typeof child !== 'string' || !SHAPE_CONVERSATION_ID.test(child) ||
          child.toLowerCase() !== rootConversationId.toLowerCase()) return false;
    }
    return true;
  }
  /** The exact direct-A envelope, or null. No descendant, alias or payload path is read. */
  function directOriginCandidateOf(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
    const conversationId = typeof frame.conversation_id === 'string' ? frame.conversation_id : null;
    if (!conversationId || !SHAPE_CONVERSATION_ID.test(conversationId)) return null;
    const input = frame.input_message;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const author = input.author;
    if (!author || typeof author !== 'object' || Array.isArray(author) || author.role !== 'user') return null;
    const metadata = input.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const requestId = metadata.request_id;
    if (typeof requestId !== 'string' || !SHAPE_OPAQUE_ID.test(requestId)) return null;
    if (!directOriginConversationAgrees(frame, conversationId)) return null;
    const route = currentRouteConversationId();
    if (!route || route.toLowerCase() !== conversationId.toLowerCase()) return null;
    if (!topLevelChatGptDocument()) return null;
    return { requestId, conversationId };
  }
  function cancelDirectOriginReaders() {
    for (const [reader, state] of directOriginReaders) {
      clearTimeout(state.timer);
      void reader.cancel().catch(() => {});
    }
    directOriginReaders.clear();
  }
  async function inspectDirectRequestOrigin(response, requestMethod) {
    if (disposed) return;
    if (requestMethod !== 'POST') return;
    if (response.status !== 200 || response.redirected !== false) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin) return;
    if (!DIRECT_ORIGIN_PATHS.has(url.pathname)) return;
    if (!exactMediaType(response, 'text/event-stream')) return;
    if (!topLevelChatGptDocument()) return;
    if (directOriginReaders.size >= 2) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), DIRECT_ORIGIN_LISTEN_MS);
    directOriginReaders.set(reader, { timer });
    const decoder = new TextDecoder();
    const terminalCandidates = new Map();
    let endedNaturally = false;
    let bytes = 0, frames = 0, buffer = '';
    const scan = (rawFrame) => {
      if (frames++ >= DIRECT_ORIGIN_MAX_EVENTS) return false;
      const candidate = directOriginCandidateOf(parseFrame(rawFrame));
      if (candidate) terminalCandidates.set(candidate.requestId, candidate.conversationId);
      if (candidate && !directOriginPublished.has(candidate.requestId)) {
        if (directOriginPublished.size >= DIRECT_ORIGIN_MAX_PUBLISHED) {
          const oldest = directOriginPublished.keys().next().value;
          if (oldest !== undefined) directOriginPublished.delete(oldest);
        }
        directOriginPublished.set(candidate.requestId, true);
        publish({
          type: 'cos-request-origin-direct',
          requestId: candidate.requestId,
          conversationId: candidate.conversationId,
          observedAt: Date.now()
        });
      }
      return true;
    };
    try {
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) {
          endedNaturally = true;
          break;
        }
        bytes += value.byteLength;
        if (bytes > DIRECT_ORIGIN_MAX_BYTES) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          if (!scan(buffer.slice(0, split))) return;
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > DIRECT_ORIGIN_MAX_FRAME || frames >= DIRECT_ORIGIN_MAX_EVENTS) return;
      }
      if (!disposed && buffer.length) scan(buffer);
      // EOF on the exact approved 200/SSE POST is terminal transport evidence, not a success
      // classification. Publish only the request/conversation identity already admitted above;
      // content.js may use this to stop calling a missed first turn "working", but never to
      // infer provider completion semantics or transcript content.
      if (!disposed && endedNaturally) {
        for (const [requestId, conversationId] of terminalCandidates) {
          if (directOriginEnded.has(requestId)) continue;
          if (directOriginEnded.size >= DIRECT_ORIGIN_MAX_PUBLISHED) {
            const oldest = directOriginEnded.keys().next().value;
            if (oldest !== undefined) directOriginEnded.delete(oldest);
          }
          directOriginEnded.set(requestId, true);
          publish({
            type: 'cos-request-origin-direct-end',
            requestId,
            conversationId,
            observedAt: Date.now()
          });
        }
      }
    } catch { /* A missing direct observation leaves matching and ownership untouched. */ }
    finally { clearTimeout(timer); directOriginReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }
  const observedSockets = new WeakSet();
  const socketListeners = [];
  function inspectSocketMessage(event) {
    // Pro hands its HTTP stream to the native conversation-turn-stream socket.
    // Observe only complete server envelopes; never subscribe, send or join deltas.
    if (disposed) return;
    const data = event?.data;
    if (typeof data !== 'string' || data.length > SHAPE_MAX_SOCKET_BYTES ||
        (data.indexOf('request_id') < 0 && data.indexOf('requestId') < 0)) return;
    let rows;
    try { rows = JSON.parse(data); } catch { return; }
    if (!Array.isArray(rows) || rows.length > SHAPE_MAX_SOCKET_ROWS) return;
    for (const row of rows) {
      const payload = row?.payload?.payload;
      if (row?.type !== 'message' || row.payload?.type !== 'conversation-turn-stream' || payload?.type !== 'stream-item') continue;
      if (typeof payload.encoded_item !== 'string' || payload.encoded_item.length > SHAPE_MAX_FRAME) continue;
      const frames = payload.encoded_item.split(/\r?\n\r?\n/);
      if (frames.length > SHAPE_MAX_SOCKET_FRAMES) continue;
      const outer = typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
      const envelope = ['message', 'conversation-turn-stream', 'stream-item'].filter(name => SHAPE_TYPE.test(name));
      for (const frame of frames) inspectShapeFrame(frame, 'socket', 'socket', envelope, outer);
    }
  }
  let observedWebSocket = null;
  function installSocketObserver() {
    if (disposed) return false;
    const current = window.WebSocket;
    if (typeof current !== 'function') return false;
    if (current === observedWebSocket) return true;
    const observed = new Proxy(current, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        if (disposed) return socket;
        try {
          const url = new URL(socket.url);
          if (url.protocol === 'wss:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
              !observedSockets.has(socket)) {
            observedSockets.add(socket);
            const listener = (event) => inspectSocketMessage(event);
            socket.addEventListener('message', listener);
            if (socketListeners.length < 16) socketListeners.push({ socket, listener });
          }
        } catch { /* Foreign/unsupported transport remains untouched. */ }
        return socket;
      }
    });
    try {
      window.WebSocket = observed;
      if (window.WebSocket !== observed) return false;
    } catch { return false; }
    observedWebSocket = observed;
    return true;
  }
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    const current = window.fetch;
    if (typeof current !== 'function') return false;
    if (fetchWrappers.some(row => row.wrapper === current)) return true;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = current;
    const observedFetch = function (...args) {
      if (disposed) return downstreamFetch.apply(this, args);
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      // The response does not carry its request method. Capture the exact call's method now;
      // the direct-A gate needs POST and must not infer it later from timing or URL shape.
      const requestMethod = (() => {
        const init = args[1];
        if (init && typeof init === 'object' && typeof init.method === 'string') return init.method.toUpperCase();
        const input = args[0];
        if (input && typeof input === 'object' && typeof input.method === 'string') return input.method.toUpperCase();
        return 'GET';
      })();
      const result = downstreamFetch.apply(this, args);
      void result.then((response) => {
        if (disposed) return;
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspect(response, observedAt, order).catch(() => {});
        // Diagnostic structure only; the clone is never used for ownership or mutation.
        void inspectRequestShapes(response, requestMethod).catch(() => {});
        // Production direct-A matching evidence; ownership still requires exact inbound equality.
        void inspectDirectRequestOrigin(response, requestMethod).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // ChatGPT replaces fetch again after document_start, often after DOMContentLoaded
    // when the app bundle boots. Re-wrap whatever is installed now. A later call is a
    // no-op while this wrapper is still the one on window.fetch.
    try {
      window.fetch = observedFetch;
      if (window.fetch !== observedFetch) return false;
    } catch { return false; }
    fetchWrappers.push({ wrapper: observedFetch, downstream: downstreamFetch });
    return true;
  };
  const reattach = () => {
    if (disposed) return false;
    const fetchAttached = installFetchObserver();
    installSocketObserver();
    return messageListenerAttached && fetchAttached;
  };
  const onMessage = (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const type = event.data?.type;
    if (type === 'cos-request-origin') {
      // No stream envelope has repository-backed request-ownership evidence. Also
      // quarantine older MAIN-world observers that may still publish this message.
      event.stopImmediatePropagation?.();
      return;
    }
    if (type === 'cos-usage') {
      if (event.data?.usageObserverVersion !== OBSERVER_VERSION) event.stopImmediatePropagation?.();
      return;
    }
    if (type === 'cos-request-shape') {
      if (event.data?.usageObserverVersion !== OBSERVER_VERSION) event.stopImmediatePropagation?.();
      return;
    }
    // Reattach only. Snapshots replay only for the explicit requests below.
    if (type === 'cos-usage-reattach') {
      reattach();
      event.stopImmediatePropagation?.();
      return;
    }
    if (type === 'cos-request-shape-request') {
      reattach();
      replayShapes();
      return;
    }
    if (type !== 'cos-usage-request') return;
    reattach();
    if (latest) publish(latest);
    // The pre-disposer observer has an anonymous listener for this same replay request.
    // Stop it after the current owner has replayed its bounded evidence.
    event.stopImmediatePropagation?.();
  };
  const onPageHide = () => {
    cancelReaders();
    cancelShapeReaders();
    cancelDirectOriginReaders();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { window.removeEventListener('message', onMessage, true); } catch {}
    try { window.removeEventListener('pagehide', onPageHide); } catch {}
    try { window.removeEventListener('DOMContentLoaded', reattach); } catch {}
    try { window.removeEventListener('load', reattach); } catch {}
    try { window.removeEventListener('pageshow', reattach); } catch {}
    messageListenerAttached = false;
    cancelReaders();
    cancelShapeReaders();
    cancelDirectOriginReaders();
    for (const row of socketListeners) {
      try { row.socket.removeEventListener('message', row.listener); } catch { /* The socket is already gone. */ }
    }
    socketListeners.length = 0;
    shapeRecords.clear();
    directOriginPublished.clear();
    directOriginEnded.clear();
    for (const row of fetchWrappers.slice().reverse()) {
      if (window.fetch === row.wrapper) {
        try { window.fetch = row.downstream; } catch { /* The page made fetch non-writable. */ }
      }
    }
    latest = null;
  };
  window.addEventListener('message', onMessage, true);
  messageListenerAttached = true;
  window.addEventListener('pagehide', onPageHide);
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', reattach, { once: true });
  if (document.readyState !== 'complete') window.addEventListener('load', reattach, { once: true });
  window.addEventListener('pageshow', reattach);
  const state = { version: OBSERVER_VERSION, revision: OBSERVER_REVISION, legacyQuarantined: legacyObserver, reattach, dispose };
  window.__cosUsageObserverState = state;
  window.__cosUsageObserver = OBSERVER_VERSION;
  state.attached = reattach();
})();
