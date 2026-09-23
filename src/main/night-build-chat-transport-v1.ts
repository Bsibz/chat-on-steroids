import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL,
  NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL_HEADER,
  type NightBuildChatConversationListV1,
  type NightBuildChatTranscriptV1,
  type NightBuildChatTransportV1Discovery
} from '../shared/night-build-chat-transport-v1.js';
import type { NightBuildChatTranscriptQuery, NightBuildChatTransportDataSource } from './night-build-chat-transport-source.js';
import { APP_VERSION } from './version.js';

const HOST = '127.0.0.1' as const;
const MAX_URL_CHARS = 1024;
const OWNERSHIP_POLL_MS = 1_000;
const HANDLE = /^[A-Za-z0-9_-]{40,64}$/;

export interface NightBuildChatTransportV1Handle {
  discovery: NightBuildChatTransportV1Discovery;
  stop(): Promise<void>;
  checkOwnershipNow(): Promise<boolean>;
}

export interface NightBuildChatTransportV1StartOptions {
  appVersion?: string;
  bridgePid?: number;
  bridgeStartedAt?: number;
  ownerIsCurrent?: () => Promise<boolean>;
  ownershipPollMs?: number;
  beforeDiscoveryCleanupClaim?: () => Promise<void>;
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

function hasRequestBody(req: http.IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const raw = req.headers['content-length'];
  if (raw === undefined) return false;
  const length = Number(Array.isArray(raw) ? raw[0] : raw);
  return !Number.isFinite(length) || length !== 0;
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

function requestHandler(
  source: NightBuildChatTransportDataSource,
  discovery: NightBuildChatTransportV1Discovery,
  allowed: () => Promise<boolean>
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'read_only' });
      if (hasRequestBody(req)) return writeJson(res, 400, { error: 'request_body_forbidden' });
      if (!req.url || req.url.length > MAX_URL_CHARS) return writeJson(res, 400, { error: 'bad_request' });
      if (req.headers.origin !== undefined) return writeJson(res, 403, { error: 'browser_origin_forbidden' });
      if (!bearerMatches(req.headers.authorization, discovery.token)) return writeJson(res, 401, { error: 'unauthorized' });
      if (req.headers[NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL_HEADER] !== String(NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL)) {
        return writeJson(res, 426, { error: 'protocol_mismatch', supportedProtocol: NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL });
      }
      if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      const url = new URL(req.url, 'http://127.0.0.1');
      let body: NightBuildChatConversationListV1 | NightBuildChatTranscriptV1;
      if (url.pathname === '/v1/conversations' && url.search === '') {
        body = {
          protocolVersion: NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL,
          appVersion: discovery.appVersion,
          transportStartedAt: discovery.startedAt,
          observedAt: Date.now(),
          conversations: await source.list()
        };
      } else if (url.pathname === '/v1/transcript') {
        let query: NightBuildChatTranscriptQuery;
        try { query = transcriptQuery(url); }
        catch { return writeJson(res, 400, { error: 'bad_request' }); }
        let projected;
        try { projected = await source.transcript(query); }
        catch (error) {
          if ((error as Error).message === 'chat_transport_conversation_not_found') return writeJson(res, 404, { error: 'conversation_not_found' });
          if ((error as Error).message === 'chat_transport_projection_changed') return writeJson(res, 409, { error: 'projection_changed' });
          throw error;
        }
        body = {
          protocolVersion: NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL,
          appVersion: discovery.appVersion,
          transportStartedAt: discovery.startedAt,
          observedAt: Date.now(),
          ...projected
        };
      } else {
        return writeJson(res, 404, { error: 'not_found' });
      }
      if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      writeJson(res, 200, body);
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  };
}

function discoveryPath(userData: string): string {
  return path.join(userData, NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE);
}

async function sameBytes(file: string, bytes: Buffer): Promise<boolean> {
  try {
    const current = await fs.readFile(file);
    return current.length === bytes.length && timingSafeEqual(current, bytes);
  } catch { return false; }
}

async function publishExclusive(userData: string, discovery: NightBuildChatTransportV1Discovery): Promise<{ file: string; bytes: Buffer }> {
  const file = discoveryPath(userData);
  const bytes = Buffer.from(JSON.stringify(discovery) + '\n');
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  return { file, bytes };
}

async function conditionalUnlink(file: string, bytes: Buffer, beforeClaim?: () => Promise<void>): Promise<void> {
  if (!(await sameBytes(file, bytes))) return;
  await beforeClaim?.();
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

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    const force = setTimeout(() => { server.closeAllConnections?.(); finish(); }, 5_000);
    force.unref?.();
    server.close(() => { clearTimeout(force); finish(); });
    server.closeIdleConnections?.();
  });
}

export async function startNightBuildChatTransportV1(
  userData: string,
  source: NightBuildChatTransportDataSource,
  options: NightBuildChatTransportV1StartOptions = {}
): Promise<NightBuildChatTransportV1Handle> {
  const discovery: NightBuildChatTransportV1Discovery = {
    protocolVersion: NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL,
    appVersion: options.appVersion ?? APP_VERSION,
    instanceId: randomUUID(),
    pid: options.bridgePid ?? process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: options.bridgeStartedAt ?? Date.now()
  };
  let allowed = async (): Promise<boolean> => true;
  const server = http.createServer({ maxHeaderSize: 8192 }, requestHandler(source, discovery, () => allowed()));
  server.requestTimeout = 10_000;
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
    throw new Error('Night Build Chat transport did not bind loopback');
  }
  discovery.port = address.port;
  let publication: { file: string; bytes: Buffer };
  try { publication = await publishExclusive(userData, discovery); }
  catch (error) { await closeServer(server); throw error; }
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (stopped) return;
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      try { await conditionalUnlink(publication.file, publication.bytes, options.beforeDiscoveryCleanupClaim); }
      finally { await closeServer(server); }
    })();
    return stopping;
  };
  const checkOwnershipNow = async (): Promise<boolean> => {
    if (stopped) return false;
    if (!(await sameBytes(publication.file, publication.bytes))) { await stop(); return false; }
    if (options.ownerIsCurrent && !(await options.ownerIsCurrent())) { await stop(); return false; }
    return true;
  };
  allowed = async () => {
    if (!(await sameBytes(publication.file, publication.bytes))) return false;
    return options.ownerIsCurrent ? options.ownerIsCurrent() : true;
  };
  const pollMs = options.ownershipPollMs ?? OWNERSHIP_POLL_MS;
  if (options.ownerIsCurrent || pollMs > 0) {
    timer = setInterval(() => { void checkOwnershipNow().catch(() => stop()); }, Math.max(10, pollMs));
    timer.unref?.();
  }
  return { discovery, stop, checkOwnershipNow };
}
