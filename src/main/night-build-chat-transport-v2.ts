import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  NIGHT_BUILD_CHAT_TRANSPORT_V2_CAPABILITIES,
  NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL,
  NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL_HEADER,
  type NightBuildChatSendCreateV2,
  type NightBuildChatStopCreateV2,
  type NightBuildChatTransportV2Discovery
} from '../shared/night-build-chat-transport-v2.js';
import type { NightBuildChatTranscriptQuery } from './night-build-chat-transport-source.js';
import type { NightBuildChatTransportV2DataSource } from './night-build-chat-transport-v2-source.js';
import { APP_VERSION } from './version.js';

const HOST = '127.0.0.1' as const;
const HANDLE = /^[A-Za-z0-9_-]{40,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_URL_CHARS = 1024;
const MAX_BODY_BYTES = 512 * 1024;

export interface NightBuildChatTransportV2Handle {
  discovery: NightBuildChatTransportV2Discovery;
  stop(): Promise<void>;
  checkOwnershipNow(): Promise<boolean>;
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

function parseSafeInteger(value: string | null, label: string, min: number, max: number): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) throw new Error(label);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(label);
  return parsed;
}

function transcriptQuery(url: URL): NightBuildChatTranscriptQuery {
  const allowed = new Set(['conversation', 'limit', 'afterRevision', 'beforeOrigin']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error('bad_query');
  const conversation = url.searchParams.get('conversation');
  if (!conversation || !HANDLE.test(conversation)) throw new Error('bad_conversation');
  const limit = parseSafeInteger(url.searchParams.get('limit'), 'bad_limit', 1, 100) ?? 100;
  const afterRevision = parseSafeInteger(url.searchParams.get('afterRevision'), 'bad_after_revision', 0, Number.MAX_SAFE_INTEGER);
  const beforeOrigin = parseSafeInteger(url.searchParams.get('beforeOrigin'), 'bad_before_origin', 1, Number.MAX_SAFE_INTEGER);
  if (afterRevision !== undefined && beforeOrigin !== undefined) throw new Error('bad_cursor');
  return {
    conversation,
    limit,
    ...(afterRevision === undefined ? {} : { afterRevision }),
    ...(beforeOrigin === undefined ? {} : { beforeOrigin })
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const transfer = req.headers['transfer-encoding'];
  if (transfer !== undefined) throw new Error('bad_body');
  const declared = req.headers['content-length'];
  if (declared === undefined || Array.isArray(declared) || !/^[1-9][0-9]{0,6}$/.test(declared)) throw new Error('bad_body');
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) throw new Error('body_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES || total > length) throw new Error('body_too_large');
    chunks.push(bytes);
  }
  if (total !== length) throw new Error('bad_body');
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad_body');
  return parsed as Record<string, unknown>;
}

function noRequestBody(req: http.IncomingMessage): boolean {
  return req.headers['transfer-encoding'] === undefined &&
    (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sendBody(value: Record<string, unknown>): NightBuildChatSendCreateV2 {
  if (!exactKeys(value, ['id', 'conversation', 'text']) ||
      typeof value.id !== 'string' || !UUID.test(value.id) ||
      typeof value.conversation !== 'string' || !HANDLE.test(value.conversation) ||
      typeof value.text !== 'string' || value.text.length === 0 || value.text.trim().length === 0 || value.text.length > 240_000) {
    throw new Error('bad_body');
  }
  return { id: value.id, conversation: value.conversation, text: value.text };
}

function stopBody(value: Record<string, unknown>): NightBuildChatStopCreateV2 {
  if (!exactKeys(value, ['id', 'sendId', 'conversation', 'turn', 'userMessage']) ||
      typeof value.id !== 'string' || !UUID.test(value.id) ||
      typeof value.sendId !== 'string' || !UUID.test(value.sendId) ||
      typeof value.conversation !== 'string' || !HANDLE.test(value.conversation) ||
      typeof value.turn !== 'string' || !HANDLE.test(value.turn) ||
      typeof value.userMessage !== 'string' || !HANDLE.test(value.userMessage)) {
    throw new Error('bad_body');
  }
  return { id: value.id, sendId: value.sendId, conversation: value.conversation, turn: value.turn, userMessage: value.userMessage };
}

function sourceError(res: http.ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('already belongs to different input')) return writeJson(res, 409, { error: 'intent_conflict' });
  if (message === 'native_chat_recording_required') return writeJson(res, 409, { error: 'recording_required' });
  if (message === 'native_chat_conversation_unavailable' || message.includes('conversation is no longer current')) return writeJson(res, 404, { error: 'conversation_unavailable' });
  if (message === 'native_chat_conversation_busy' || message.includes('conversation is not idle')) return writeJson(res, 409, { error: 'conversation_busy' });
  if (message === 'native_chat_browser_unavailable') return writeJson(res, 503, { error: 'browser_unavailable' });
  if (message === 'native_stop_intent_conflict') return writeJson(res, 409, { error: 'intent_conflict' });
  if (message === 'native_chat_stop_turn_changed' || message === 'active_turn_changed') return writeJson(res, 409, { error: 'turn_changed' });
  if (message === 'native_chat_stop_already_pending' || message === 'native_stop_already_pending') return writeJson(res, 409, { error: 'stop_already_pending' });
  if (message === 'native_chat_stop_unavailable' || message === 'stop_request_not_durable' || message === 'native_stop_dispatch_unknown') {
    return writeJson(res, 503, { error: 'stop_unavailable' });
  }
  writeJson(res, 500, { error: 'internal_error' });
}

function requestHandler(
  source: NightBuildChatTransportV2DataSource,
  discovery: NightBuildChatTransportV2Discovery,
  allowed: () => Promise<boolean>,
  inFlight: Set<Promise<void>>
): http.RequestListener {
  return (req, res) => {
    const operation = (async () => {
      if (!req.url || req.url.length > MAX_URL_CHARS) return writeJson(res, 400, { error: 'bad_request' });
      if (req.headers.origin !== undefined) return writeJson(res, 403, { error: 'browser_origin_forbidden' });
      if (!bearerMatches(req.headers.authorization, discovery.token)) return writeJson(res, 401, { error: 'unauthorized' });
      if (req.headers[NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL_HEADER] !== String(NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL)) {
        return writeJson(res, 426, { error: 'protocol_mismatch', supportedProtocol: NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL });
      }
      if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const common = {
        protocolVersion: NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL,
        appVersion: discovery.appVersion,
        transportStartedAt: discovery.startedAt,
        observedAt: Date.now()
      } as const;
      try {
        if (url.pathname === '/v2/conversations') {
          if (req.method !== 'GET') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const conversations = await source.list();
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common, conversations });
        }
        if (url.pathname === '/v2/transcript') {
          if (req.method !== 'GET') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (!noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const transcript = await source.transcript(transcriptQuery(url));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common, ...transcript });
        }
        if (url.pathname === '/v2/send-intents') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '') return writeJson(res, 400, { error: 'bad_request' });
          const body = sendBody(await readJsonBody(req));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          const intent = await source.createSend(body);
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 202, { ...common, ...intent });
        }
        const send = url.pathname.match(/^\/v2\/send-intents\/([0-9a-f-]{36})(\/inspect)?$/i);
        if (send && UUID.test(send[1]!)) {
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = send[2]
            ? req.method === 'POST' ? await source.inspectSend(send[1]!) : undefined
            : req.method === 'GET' ? await source.send(send[1]!) : undefined;
          if (intent === undefined) return writeJson(res, 405, { error: 'method_not_allowed' });
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common, ...intent });
        }
        if (url.pathname === '/v2/stop-intents') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '') return writeJson(res, 400, { error: 'bad_request' });
          const body = stopBody(await readJsonBody(req));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          const intent = await source.createStop(body);
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 202, { ...common, ...intent });
        }
        const stop = url.pathname.match(/^\/v2\/stop-intents\/([0-9a-f-]{36})$/i);
        if (stop && UUID.test(stop[1]!)) {
          if (req.method !== 'GET') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = await source.stop(stop[1]!);
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common, ...intent });
        }
        return writeJson(res, 404, { error: 'not_found' });
      } catch (error) {
        if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
        if ((error as Error).message === 'bad_body' || error instanceof SyntaxError || (error as Error).message.startsWith('bad_')) {
          return writeJson(res, 400, { error: 'bad_request' });
        }
        if ((error as Error).message === 'body_too_large') return writeJson(res, 413, { error: 'body_too_large' });
        if ((error as Error).message === 'chat_transport_conversation_not_found') return writeJson(res, 404, { error: 'conversation_not_found' });
        if ((error as Error).message === 'chat_transport_projection_changed') return writeJson(res, 409, { error: 'projection_changed' });
        return sourceError(res, error);
      }
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
    inFlight.add(operation);
    void operation.then(
      () => { inFlight.delete(operation); },
      () => { inFlight.delete(operation); }
    );
  };
}

async function sameBytes(file: string, bytes: Buffer): Promise<boolean> {
  try {
    const current = await fs.readFile(file);
    return current.length === bytes.length && timingSafeEqual(current, bytes);
  } catch { return false; }
}

async function conditionalUnlink(file: string, bytes: Buffer): Promise<void> {
  if (!(await sameBytes(file, bytes))) return;
  const claimed = file + '.cleanup-' + randomUUID();
  try { await fs.rename(file, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (await sameBytes(claimed, bytes)) {
    await fs.rm(claimed, { force: true });
    return;
  }
  try { await fs.link(claimed, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  await fs.rm(claimed, { force: true });
}

function definitelyDeadPid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function publishDiscovery(file: string, bytes: Buffer): Promise<void> {
  try {
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let staleBytes: Buffer;
    let stale: Partial<NightBuildChatTransportV2Discovery>;
    try {
      staleBytes = await fs.readFile(file);
      if (staleBytes.length === 0 || staleBytes.length > 16 * 1024) throw new Error('discovery_invalid');
      stale = JSON.parse(staleBytes.toString('utf8')) as Partial<NightBuildChatTransportV2Discovery>;
    } catch {
      throw error;
    }
    // Never steal a live/unknown generation. PID reuse therefore fails closed:
    // it can temporarily disable writes, but cannot transfer write authority.
    if (stale.protocolVersion !== NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL ||
        stale.host !== HOST || !definitelyDeadPid(Number(stale.pid))) {
      throw error;
    }
    await conditionalUnlink(file, staleBytes);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => { if (!settled) { settled = true; resolve(); } };
    const force = setTimeout(() => { server.closeAllConnections?.(); finish(); }, 5_000);
    force.unref?.();
    server.close(() => { clearTimeout(force); finish(); });
    server.closeIdleConnections?.();
  });
}

async function drainRequests(inFlight: Set<Promise<void>>): Promise<void> {
  // New requests are refused once admission closes, but a request can already
  // have crossed the listener boundary. Re-snapshot until every source
  // operation has settled so stop() is a real mutation drain, not merely a
  // socket-close acknowledgement.
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

export async function startNightBuildChatTransportV2(
  userData: string,
  source: NightBuildChatTransportV2DataSource,
  options: { appVersion?: string; startedAt?: number; pid?: number } = {}
): Promise<NightBuildChatTransportV2Handle> {
  const discovery: NightBuildChatTransportV2Discovery = {
    protocolVersion: NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL,
    appVersion: options.appVersion ?? APP_VERSION,
    instanceId: randomUUID(),
    pid: options.pid ?? process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: options.startedAt ?? Date.now(),
    capabilities: NIGHT_BUILD_CHAT_TRANSPORT_V2_CAPABILITIES
  };
  let admitted = true;
  let allowed = async (): Promise<boolean> => admitted;
  const inFlight = new Set<Promise<void>>();
  const server = http.createServer({ maxHeaderSize: 8192 }, requestHandler(source, discovery, () => allowed(), inFlight));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once('error', failed);
    server.listen(0, HOST, () => { server.off('error', failed); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== HOST) {
    await closeServer(server);
    throw new Error('Night Build Chat v2 transport did not bind loopback');
  }
  discovery.port = address.port;
  const file = path.join(userData, NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE);
  const bytes = Buffer.from(JSON.stringify(discovery) + '\n');
  try {
    await publishDiscovery(file, bytes);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  allowed = async () => admitted && await sameBytes(file, bytes);
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopping) stopping = (async () => {
      admitted = false;
      try { await conditionalUnlink(file, bytes); }
      finally {
        await Promise.all([closeServer(server), drainRequests(inFlight)]);
      }
    })();
    return stopping;
  };
  const checkOwnershipNow = async (): Promise<boolean> => {
    if (await allowed()) return true;
    await stop();
    return false;
  };
  return {
    discovery: { ...discovery },
    stop,
    checkOwnershipNow
  };
}
