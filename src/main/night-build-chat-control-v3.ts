import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES,
  NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE,
  NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL,
  NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER,
  type NightBuildChatConfiguredSendCreateV3,
  type NightBuildChatFreshSendCreateV3,
  type NightBuildChatControlV3Discovery
} from '../shared/night-build-chat-control-v3.js';
import type { InputAttachment } from '../shared/input.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import { attachmentSchema } from './session/input-attachments.js';
import type { NightBuildChatControlV3DataSource } from './night-build-chat-control-v3-source.js';
import { APP_VERSION } from './version.js';

const HOST = '127.0.0.1' as const;
const HANDLE = /^[A-Za-z0-9_-]{40,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[a-zA-Z0-9._-]{1,80}$/;
const MAX_URL_CHARS = 2048;
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_STAGED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const EFFORTS = new Set<string>(REASONING_EFFORTS);

export interface NightBuildChatControlV3Handle {
  discovery: NightBuildChatControlV3Discovery;
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

function configuredSendBody(value: Record<string, unknown>): NightBuildChatConfiguredSendCreateV3 {
  if (!exactKeys(value, ['id', 'conversation', 'text', 'model', 'reasoningEffort', 'attachments']) ||
      typeof value.id !== 'string' || !UUID.test(value.id) ||
      typeof value.conversation !== 'string' || !HANDLE.test(value.conversation) ||
      typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > 240_000 ||
      !(value.model === null || (typeof value.model === 'string' && MODEL.test(value.model))) ||
      !(value.reasoningEffort === null || (typeof value.reasoningEffort === 'string' && EFFORTS.has(value.reasoningEffort))) ||
      !Array.isArray(value.attachments) || value.attachments.length > 4) {
    throw new Error('bad_body');
  }
  const attachments: InputAttachment[] = [];
  for (const raw of value.attachments) {
    const parsed = attachmentSchema.safeParse(raw);
    if (!parsed.success) throw new Error('bad_body');
    const object = raw as Record<string, unknown>;
    const allowed = new Set(['id', 'name', 'size', 'mimeType', 'preview']);
    if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error('bad_body');
    attachments.push(parsed.data);
  }
  return {
    id: value.id,
    conversation: value.conversation,
    text: value.text,
    model: value.model as string | null,
    reasoningEffort: value.reasoningEffort as NightBuildChatConfiguredSendCreateV3['reasoningEffort'],
    attachments
  };
}

function freshSendBody(value: Record<string, unknown>): NightBuildChatFreshSendCreateV3 {
  if (!exactKeys(value, ['id', 'sourceConversation', 'text', 'model', 'reasoningEffort', 'attachments']) ||
      typeof value.id !== 'string' || !UUID.test(value.id) ||
      typeof value.sourceConversation !== 'string' || !HANDLE.test(value.sourceConversation) ||
      typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > 240_000 ||
      !(value.model === null || (typeof value.model === 'string' && MODEL.test(value.model))) ||
      !(value.reasoningEffort === null || (typeof value.reasoningEffort === 'string' && EFFORTS.has(value.reasoningEffort))) ||
      !Array.isArray(value.attachments) || value.attachments.length > 4) {
    throw new Error('bad_body');
  }
  const attachments: InputAttachment[] = [];
  for (const raw of value.attachments) {
    const parsed = attachmentSchema.safeParse(raw);
    if (!parsed.success) throw new Error('bad_body');
    const object = raw as Record<string, unknown>;
    const allowed = new Set(['id', 'name', 'size', 'mimeType', 'preview']);
    if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error('bad_body');
    attachments.push(parsed.data);
  }
  return {
    id: value.id,
    sourceConversation: value.sourceConversation,
    text: value.text,
    model: value.model as string | null,
    reasoningEffort: value.reasoningEffort as NightBuildChatFreshSendCreateV3['reasoningEffort'],
    attachments
  };
}

function sourceError(res: http.ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('already belongs to different input')) return writeJson(res, 409, { error: 'intent_conflict' });
  if (message === 'native_chat_recording_required') return writeJson(res, 409, { error: 'recording_required' });
  if (message === 'native_chat_conversation_unavailable' || message.includes('conversation is no longer current')) {
    return writeJson(res, 404, { error: 'conversation_unavailable' });
  }
  if (message === 'Fresh native Chat source is unavailable') {
    return writeJson(res, 404, { error: 'conversation_unavailable' });
  }
  if (message === 'native_chat_conversation_busy' || message.includes('conversation is not idle')) {
    return writeJson(res, 409, { error: 'conversation_busy' });
  }
  if (message === 'native_chat_browser_unavailable') return writeJson(res, 503, { error: 'browser_unavailable' });
  if (message === 'native_chat_model_catalog_unavailable') return writeJson(res, 409, { error: 'model_catalog_unavailable' });
  if (message === 'native_chat_model_unavailable') return writeJson(res, 409, { error: 'model_unavailable' });
  if (message === 'native_chat_effort_unavailable') return writeJson(res, 409, { error: 'effort_unavailable' });
  if (/attachment/i.test(message)) return writeJson(res, 409, { error: 'attachment_unavailable' });
  writeJson(res, 500, { error: 'internal_error' });
}

function requestHandler(
  source: NightBuildChatControlV3DataSource,
  discovery: NightBuildChatControlV3Discovery,
  allowed: () => Promise<boolean>,
  inFlight: Set<Promise<void>>
): http.RequestListener {
  return (req, res) => {
    const operation = (async () => {
      if (!req.url || req.url.length > MAX_URL_CHARS) return writeJson(res, 400, { error: 'bad_request' });
      if (req.headers.origin !== undefined) return writeJson(res, 403, { error: 'browser_origin_forbidden' });
      if (!bearerMatches(req.headers.authorization, discovery.token)) return writeJson(res, 401, { error: 'unauthorized' });
      if (req.headers[NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER] !== String(NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL)) {
        return writeJson(res, 426, { error: 'protocol_mismatch', supportedProtocol: NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL });
      }
      if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const common = () => ({
        protocolVersion: NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL,
        appVersion: discovery.appVersion,
        transportStartedAt: discovery.startedAt,
        observedAt: Date.now()
      } as const);
      try {
        if (url.pathname === '/v3/state') {
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
        if (url.pathname === '/v3/models/refresh') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          await source.refreshModels();
          return writeJson(res, 202, { ...common(), state: 'requested' });
        }
        if (url.pathname === '/v3/attachments') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          const keys = [...url.searchParams.keys()];
          const name = url.searchParams.get('name');
          if (keys.length !== 1 || keys[0] !== 'name' || !name || name.length > 255 || name.includes('\0')) {
            return writeJson(res, 400, { error: 'bad_request' });
          }
          const bytes = await readBody(req, MAX_STAGED_ATTACHMENT_BYTES);
          if (bytes.length === 0) return writeJson(res, 400, { error: 'bad_request' });
          const attachment = await source.stageAttachment(name, bytes);
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 201, { ...common(), attachment });
        }
        if (url.pathname === '/v3/send-intents') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '') return writeJson(res, 400, { error: 'bad_request' });
          const intent = await source.createSend(configuredSendBody(await readJsonBody(req)));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 202, { ...common(), ...intent });
        }
        if (url.pathname === '/v3/fresh-send-intents') {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '') return writeJson(res, 400, { error: 'bad_request' });
          const intent = await source.createFreshSend(freshSendBody(await readJsonBody(req)));
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 202, { ...common(), ...intent });
        }
        const cancelSend = url.pathname.match(/^\/v3\/send-intents\/([0-9a-f-]{36})\/cancel$/i);
        if (cancelSend && UUID.test(cancelSend[1]!)) {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = await source.cancelSend(cancelSend[1]!);
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...intent });
        }
        const cancelFresh = url.pathname.match(/^\/v3\/fresh-send-intents\/([0-9a-f-]{36})\/cancel$/i);
        if (cancelFresh && UUID.test(cancelFresh[1]!)) {
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method_not_allowed' });
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = await source.cancelFreshSend(cancelFresh[1]!);
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...intent });
        }
        const send = url.pathname.match(/^\/v3\/send-intents\/([0-9a-f-]{36})(\/inspect)?$/i);
        if (send && UUID.test(send[1]!)) {
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = send[2]
            ? req.method === 'POST' ? await source.inspectSend(send[1]!) : undefined
            : req.method === 'GET' ? await source.send(send[1]!) : undefined;
          if (intent === undefined) return writeJson(res, 405, { error: 'method_not_allowed' });
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...intent });
        }
        const fresh = url.pathname.match(/^\/v3\/fresh-send-intents\/([0-9a-f-]{36})(\/inspect)?$/i);
        if (fresh && UUID.test(fresh[1]!)) {
          if (url.search !== '' || !noRequestBody(req)) return writeJson(res, 400, { error: 'bad_request' });
          const intent = fresh[2]
            ? req.method === 'POST' ? await source.inspectFreshSend(fresh[1]!) : undefined
            : req.method === 'GET' ? await source.freshSend(fresh[1]!) : undefined;
          if (intent === undefined) return writeJson(res, 405, { error: 'method_not_allowed' });
          if (!intent) return writeJson(res, 404, { error: 'intent_not_found' });
          if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
          return writeJson(res, 200, { ...common(), ...intent });
        }
        return writeJson(res, 404, { error: 'not_found' });
      } catch (error) {
        if (!(await allowed())) return writeJson(res, 503, { error: 'controller_unavailable' });
        if (error instanceof SyntaxError || (error as Error).message === 'bad_body' || (error as Error).message.startsWith('bad_')) {
          return writeJson(res, 400, { error: 'bad_request' });
        }
        if ((error as Error).message === 'body_too_large') return writeJson(res, 413, { error: 'body_too_large' });
        return sourceError(res, error);
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
    const stale = JSON.parse(staleBytes.toString('utf8')) as Partial<NightBuildChatControlV3Discovery>;
    if (stale.protocolVersion !== NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL ||
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

export async function startNightBuildChatControlV3(
  userData: string,
  source: NightBuildChatControlV3DataSource,
  options: { appVersion?: string; startedAt?: number; pid?: number; instanceId?: string } = {}
): Promise<NightBuildChatControlV3Handle> {
  if (options.instanceId !== undefined && !UUID.test(options.instanceId)) {
    throw new Error('Night Build Chat v3 control instance id is invalid');
  }
  const discovery: NightBuildChatControlV3Discovery = {
    protocolVersion: NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL,
    appVersion: options.appVersion ?? APP_VERSION,
    instanceId: options.instanceId ?? randomUUID(),
    pid: options.pid ?? process.pid,
    host: HOST,
    port: 0,
    token: randomBytes(32).toString('base64url'),
    startedAt: options.startedAt ?? Date.now(),
    capabilities: NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES
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
    throw new Error('Night Build Chat v3 control did not bind loopback');
  }
  discovery.port = address.port;
  const file = path.join(userData, NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE);
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
