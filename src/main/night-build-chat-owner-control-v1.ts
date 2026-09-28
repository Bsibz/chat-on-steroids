import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES,
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL,
  NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER,
  type NightBuildChatOwnerControlV1Discovery,
  type NightBuildChatOwnerModeV1
} from '../shared/night-build-chat-owner-control-v1.js';
import type { NightBuildChatOwnerControlV1DataSource } from './night-build-chat-owner-control-v1-source.js';
import { APP_VERSION } from './version.js';

const HOST = '127.0.0.1' as const;
const HANDLE = /^[A-Za-z0-9_-]{40,64}$/;
const MAX_URL_CHARS = 2048;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MODES = new Set<string>(['off', 'goal', 'loop']);

export interface NightBuildChatOwnerControlV1Handle {
  discovery: NightBuildChatOwnerControlV1Discovery;
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

function noRequestBody(req: http.IncomingMessage): boolean {
  return req.headers['transfer-encoding'] === undefined &&
    (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
}

async function readBody(req: http.IncomingMessage, maximum: number): Promise<Buffer> {
  if (req.headers['transfer-encoding'] !== undefined) throw new Error('bad_body');
  const declared = req.headers['content-length'];
  if (declared === undefined || Array.isArray(declared) || !/^(?:0|[1-9][0-9]{0,8})$/.test(declared)) {
    throw new Error('bad_body');
  }
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error('body_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > length || total > maximum) throw new Error('body_too_large');
    chunks.push(bytes);
  }
  if (total !== length) throw new Error('bad_body');
  return Buffer.concat(chunks);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, MAX_JSON_BODY_BYTES);
  if (bytes.length === 0) throw new Error('bad_body');
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad_body');
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function autoCompactionBody(value: Record<string, unknown>): boolean {
  if (!exactKeys(value, ['enabled']) || typeof value.enabled !== 'boolean') throw new Error('bad_body');
  return value.enabled;
}

function modeBody(value: Record<string, unknown>): NightBuildChatOwnerModeV1 {
  if (!exactKeys(value, ['mode']) || typeof value.mode !== 'string' || !MODES.has(value.mode)) {
    throw new Error('bad_body');
  }
  return value.mode as NightBuildChatOwnerModeV1;
}

function ownerError(res: http.ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'native_chat_conversation_unavailable':
    case 'session_not_recorded':
      return writeJson(res, 404, { error: 'conversation_unavailable' });
    case 'native_chat_conversation_changed':
    case 'conversation_changed':
      return writeJson(res, 409, { error: 'conversation_changed' });
    case 'conversation_superseded':
      return writeJson(res, 409, { error: 'conversation_superseded' });
    case 'native_chat_mutation_pending':
      return writeJson(res, 409, { error: 'conversation_busy' });
    case 'native_chat_recording_required':
      return writeJson(res, 409, { error: 'recording_required' });
    case 'native_chat_browser_unavailable':
      return writeJson(res, 503, { error: 'browser_unavailable' });
    case 'worker_compaction_disabled':
      return writeJson(res, 409, { error: 'worker_compaction_disabled' });
    case 'worker_goal_disabled':
      return writeJson(res, 409, { error: 'worker_goal_disabled' });
    case 'chat_blocked':
      return writeJson(res, 409, { error: 'chat_blocked' });
    case 'goal_switch_capacity':
      return writeJson(res, 409, { error: 'goal_switch_capacity' });
    default:
      writeJson(res, 500, { error: 'internal_error' });
  }
}

function requestHandler(
  source: NightBuildChatOwnerControlV1DataSource,
  discovery: NightBuildChatOwnerControlV1Discovery,
  allowed: () => Promise<boolean>,
  inFlight: Set<Promise<void>>
): http.RequestListener {
  return (req, res) => {
    const operation = (async () => {
      if (!req.url || req.url.length > MAX_URL_CHARS) return writeJson(res, 400, { error: 'bad_request' });
      if (req.headers.origin !== undefined) return writeJson(res, 403, { error: 'browser_origin_forbidden' });
      if (!bearerMatches(req.headers.authorization, discovery.token)) return writeJson(res, 401, { error: 'unauthorized' });
      if (req.headers[NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER] !== String(NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL)) {
        return writeJson(res, 426, {
          error: 'protocol_mismatch',
          supportedProtocol: NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL
        });
      }
      if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const common = () => ({
        protocolVersion: NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL,
        appVersion: discovery.appVersion,
        transportStartedAt: discovery.startedAt,
        observedAt: Date.now()
      } as const);
      try {
        if (url.pathname === '/owner/state') {
          if (req.method !== 'GET' || !noRequestBody(req)) return writeJson(res, 405, { error: 'method_not_allowed' });
          const keys = [...url.searchParams.keys()];
          const conversation = url.searchParams.get('conversation');
          if (keys.length !== 1 || keys[0] !== 'conversation' || !conversation || !HANDLE.test(conversation)) {
            return writeJson(res, 400, { error: 'bad_request' });
          }
          const state = await source.state(conversation);
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...state });
        }
        const scoped = url.pathname.match(
          /^\/owner\/conversations\/([A-Za-z0-9_-]{40,64})\/(auto-compaction|mode|compaction|compaction\/cancel)$/
        );
        if (scoped && HANDLE.test(scoped[1]!)) {
          const conversation = scoped[1]!;
          const action = scoped[2]!;
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (action === 'compaction' || action === 'compaction/cancel') {
            if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
            if (action === 'compaction') {
              const state = await source.compact(conversation);
              if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
              return writeJson(res, 202, { ...common(), ...state });
            }
            const state = await source.cancelCompaction(conversation);
            if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
            return writeJson(res, 200, { ...common(), ...state });
          }
          if (url.search !== '') return writeJson(res, 400, { error: 'bad_request' });
          const body = await readJsonBody(req);
          if (action === 'mode') {
            const state = await source.setMode(conversation, modeBody(body));
            if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
            return writeJson(res, 200, { ...common(), ...state });
          }
          const state = await source.setAutoCompaction(conversation, autoCompactionBody(body));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...state });
        }
        return writeJson(res, 404, { error: 'not_found' });
      } catch (error) {
        if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
        if (error instanceof SyntaxError || (error as Error).message === 'bad_body' || (error as Error).message.startsWith('bad_')) {
          return writeJson(res, 400, { error: 'bad_request' });
        }
        if ((error as Error).message === 'body_too_large') return writeJson(res, 413, { error: 'body_too_large' });
        return ownerError(res, error);
      }
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
    inFlight.add(operation);
    void operation.finally(() => { inFlight.delete(operation); });
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
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function publishDiscovery(file: string, bytes: Buffer): Promise<void> {
  try {
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const staleBytes = await fs.readFile(file);
    if (staleBytes.length === 0 || staleBytes.length > 16 * 1024) throw error;
    const stale = JSON.parse(staleBytes.toString('utf8')) as Partial<NightBuildChatOwnerControlV1Discovery>;
    if (stale.protocolVersion !== NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL ||
        stale.host !== HOST || !definitelyDeadPid(Number(stale.pid))) throw error;
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
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export async function startNightBuildChatOwnerControlV1(
  userData: string,
  source: NightBuildChatOwnerControlV1DataSource,
  options: { appVersion?: string; startedAt?: number; pid?: number; instanceId?: string } = {}
): Promise<NightBuildChatOwnerControlV1Handle> {
  if (options.instanceId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.instanceId)) {
    throw new Error('Night Build Chat owner control v1 instance id is invalid');
  }
  const discovery: NightBuildChatOwnerControlV1Discovery = {
    protocolVersion: NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL,
    appVersion: options.appVersion ?? APP_VERSION,
    instanceId: options.instanceId ?? randomUUID(),
    pid: options.pid ?? process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: options.startedAt ?? Date.now(),
    capabilities: NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES
  };
  let admitted = true;
  let allowed = async (): Promise<boolean> => admitted;
  const inFlight = new Set<Promise<void>>();
  const server = http.createServer({ maxHeaderSize: 8192 }, requestHandler(source, discovery, () => allowed(), inFlight));
  server.requestTimeout = 30_000;
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
    throw new Error('Night Build Chat owner control v1 did not bind loopback');
  }
  discovery.port = address.port;
  const file = path.join(userData, NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE);
  const bytes = Buffer.from(JSON.stringify(discovery) + '\n');
  try { await publishDiscovery(file, bytes); }
  catch (error) { await closeServer(server); throw error; }
  allowed = async () => admitted && await sameBytes(file, bytes);
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopping) stopping = (async () => {
      admitted = false;
      try { await conditionalUnlink(file, bytes); }
      finally { await Promise.all([closeServer(server), drainRequests(inFlight)]); }
    })();
    return stopping;
  };
  return {
    discovery: { ...discovery },
    stop,
    async checkOwnershipNow() {
      if (await allowed()) return true;
      await stop();
      return false;
    }
  };
}
