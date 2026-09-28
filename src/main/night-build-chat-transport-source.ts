import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  NightBuildChatActivityItemV1,
  NightBuildChatConversationListV1,
  NightBuildChatConversationV1,
  NightBuildChatCurrentTurnV1,
  NightBuildChatTranscriptItemV1,
  NightBuildChatTranscriptV1,
  NightBuildChatTurnOutcome
} from '../shared/night-build-chat-transport-v1.js';
import {
  parseNightBuildActivityCandidate,
  projectNightBuildToolActivity,
  type NightBuildActivityCandidate
} from './session/tool-activity.js';

const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const CHAT_ID = /^[0-9a-z_-]{8,256}$/i;
const FALLBACK_MESSAGE_TURN_ID = /^fallback-turn-\d+:\d+:(?:user|assistant)$/;
const MESSAGE_FILE = /^[0-9a-f]{64}\.json$/;
const OUTCOMES: readonly NightBuildChatTurnOutcome[] = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'];
const CONTINUATION_MARKER = /^\s*\[\[CLF-(HANDOFF|RESUME):([A-Za-z0-9_-]{16,64})\]\](?:\s|$)/;
const CONTINUATION_MARKER_ESCAPED = /^\s*(?:\\?\[){2}CLF\\?-(HANDOFF|RESUME)\\?:((?:[A-Za-z0-9]|\\?[_-]){16,64})(?:\\?\]){2}(?:\s|$)/;
const MAX_META_BYTES = 1024 * 1024;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_LEGACY_CANONICAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_LINE_BYTES = 512 * 1024;
const MAX_HANDOFF_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 5_000;
const MAX_CANONICAL_ROWS = 5_000;
const MAX_JOURNAL_ROWS = 250_000;
const MAX_TURNS = 20_000;
const MAX_TEXT = 256_000;

type JsonObject = Record<string, unknown>;

interface TimelineTurn {
  origin: number;
  time: number;
  questionId?: string;
  endTime?: number;
  endOrigin?: number;
  responseTurnId?: string;
}

interface RequestTurn {
  turnId: string;
  conversationId: string;
  origin: number;
}

interface IdentityState {
  timelineTurns: Record<string, TimelineTurn>;
  requestTurns: Record<string, RequestTurn | null>;
  nativeQuestion: { messageId: string; origin: number } | null;
}

interface SessionMeta extends IdentityState {
  id: string;
  title: string;
  conversationId: string;
  chatIds: string[];
  updatedAt: number;
  activeTurnId: string | null;
  lastCommittedResumeHandoffId: string | null;
  historySeq: number;
}

interface CanonicalMessage {
  key: string;
  kind: 'user_message' | 'assistant_message';
  source: 'extension' | 'mcp' | 'app';
  messageId: string;
  providerMessageId?: string;
  inputId?: string;
  inputDelivery?: 'offered' | 'confirmed';
  seq: number;
  origin: number;
  time: number;
  authoredAt?: number;
  authoredText?: string;
  agent?: string;
  turnId?: string;
  text: string;
  truncated: boolean;
  chars: number;
  attachments?: Array<{ id: string; name: string; size: number; mimeType: string; preview?: string }>;
  state?: 'streaming' | 'final';
  finalContentSeq?: number;
}

interface CanonicalIdentityToolCall extends JournalIdentityEvent {
  key: string;
  kind: 'tool_call';
  turnId: string;
  request: { requestId: string; conversationId: string };
}

interface JournalIdentityEvent {
  seq: number;
  time: number;
  kind: 'turn_start' | 'turn_end' | 'tool_call' | 'handoff';
  turnId?: string;
  outcome?: NightBuildChatTurnOutcome;
  handoffId?: string;
  request?: { requestId: string; conversationId: string };
}

interface JournalProgress {
  progressId: string;
  origin: number;
  seq: number;
  time: number;
  turnId: string;
  text: string;
  truncated: boolean;
  chars: number;
}

interface JournalSnapshot {
  maxSeq: number;
  activeTurnId: string | null;
  identityEvents: JournalIdentityEvent[];
  turnEnds: Array<{ seq: number; time: number; turnId: string; outcome: NightBuildChatTurnOutcome }>;
  handoffs: Array<{ seq: number; handoffId: string }>;
  toolActivity: NightBuildActivityCandidate[];
  progress: JournalProgress[];
}

interface CatalogRow { directoryId: string; meta: SessionMeta }
interface SelectedProjection {
  row: CatalogRow;
  messages: CanonicalMessage[];
  journal: JournalSnapshot;
  identity: IdentityState;
  identitySource: 'metadata' | 'rebuilt';
  lowerBoundOrigin: number;
  highWaterSeq: number;
  assistantResponseOrigins: Map<string, number | null>;
  toolActivity: NightBuildActivityCandidate[];
}

export interface NightBuildChatTranscriptQuery {
  conversation: string;
  limit: number;
  afterRevision?: number;
  beforeOrigin?: number;
}

export interface NightBuildChatTransportDataSource {
  list(): Promise<NightBuildChatConversationListV1['conversations']>;
  transcript(query: NightBuildChatTranscriptQuery): Promise<Omit<NightBuildChatTranscriptV1, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>>;
}

/**
 * Internal-only identity behind one opaque Night Build conversation handle.
 *
 * Raw recorder/session/ChatGPT ids never cross the loopback Chat transport.
 * The primary-process write service uses this solely to bind an owner request
 * to the same ordinary conversation that the read projection admitted.
 */
export interface NightBuildChatResolvedConversation {
  handle: string;
  sessionId: string;
  conversationId: string;
  title: string;
  updatedAt: number;
}

/** Exact native-send receipt once recorder identity has caught up with input history. */
export interface NightBuildChatNativeSendProof {
  messageId: string;
  turnId: string;
  turnOrigin: number;
  revisionSeq: number;
}

export async function nightBuildChatHandleForIdentity(
  userData: string,
  salt: string,
  sessionId: string,
  conversationId: string
): Promise<string | null> {
  if (!salt) throw new Error('chat_transport_salt_missing');
  const rows = (await catalogRows(userData)).filter((row) =>
    row.directoryId === sessionId && row.meta.conversationId === conversationId
  );
  return rows.length === 1 ? conversationHandle(rows[0]!, salt) : null;
}

function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as JsonObject;
}

function safeInt(value: unknown, code: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) throw new Error(code);
  return value as number;
}

function nullableString(value: unknown, code: string, max = 512): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(code);
  return value;
}

function requiredString(value: unknown, code: string, max = 512): string {
  const parsed = nullableString(value, code, max);
  if (parsed === null) throw new Error(code);
  return parsed;
}

function optionalString(value: unknown, code: string, max = 512): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, code, max);
}

function opaque(salt: string, domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(salt).update('\0').update(value).digest('base64url');
}

async function readBounded(file: string, maxBytes: number, allowEmpty = false): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size < 0 || (!allowEmpty && stat.size === 0) || stat.size > maxBytes) throw new Error('chat_transport_file_size_invalid');
  const raw = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('chat_transport_file_size_invalid');
  if (!allowEmpty && raw.length === 0) throw new Error('chat_transport_file_size_invalid');
  return raw;
}

async function readJson(file: string, maxBytes: number): Promise<unknown> {
  const raw = await readBounded(file, maxBytes);
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error('chat_transport_json_invalid'); }
}

async function readOptionalJson(file: string, maxBytes: number): Promise<unknown | null> {
  try { return await readJson(file, maxBytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseTimelineTurns(value: unknown): Record<string, TimelineTurn> {
  const root = object(value, 'chat_transport_timeline_invalid');
  const entries = Object.entries(root);
  if (entries.length > MAX_TURNS) throw new Error('chat_transport_timeline_limit');
  const out: Record<string, TimelineTurn> = {};
  for (const [id, raw] of entries) {
    if (!CHAT_ID.test(id)) throw new Error('chat_transport_turn_id_invalid');
    const row = object(raw, 'chat_transport_turn_invalid');
    const questionId = optionalString(row['questionId'], 'chat_transport_question_invalid');
    const responseTurnId = optionalString(row['responseTurnId'], 'chat_transport_response_turn_invalid');
    const endTime = row['endTime'] === undefined ? undefined : safeInt(row['endTime'], 'chat_transport_turn_end_time_invalid');
    const endOrigin = row['endOrigin'] === undefined ? undefined : safeInt(row['endOrigin'], 'chat_transport_turn_end_origin_invalid', false);
    out[id] = {
      origin: safeInt(row['origin'], 'chat_transport_turn_origin_invalid', false),
      time: safeInt(row['time'], 'chat_transport_turn_time_invalid'),
      ...(questionId ? { questionId } : {}),
      ...(responseTurnId ? { responseTurnId } : {}),
      ...(endTime === undefined ? {} : { endTime }),
      ...(endOrigin === undefined ? {} : { endOrigin })
    };
  }
  return out;
}

function parseRequestTurns(value: unknown): Record<string, RequestTurn | null> {
  const root = object(value, 'chat_transport_request_turns_invalid');
  const entries = Object.entries(root);
  if (entries.length > MAX_TURNS) throw new Error('chat_transport_request_turns_limit');
  const out: Record<string, RequestTurn | null> = {};
  for (const [requestId, raw] of entries) {
    if (!CHAT_ID.test(requestId)) throw new Error('chat_transport_request_id_invalid');
    if (raw === null) { out[requestId] = null; continue; }
    const row = object(raw, 'chat_transport_request_turn_invalid');
    const turnId = requiredString(row['turnId'], 'chat_transport_request_turn_id_invalid');
    const conversationId = requiredString(row['conversationId'], 'chat_transport_request_conversation_invalid', 256);
    if (!CHAT_ID.test(turnId) || !CHAT_ID.test(conversationId)) throw new Error('chat_transport_request_turn_invalid');
    out[requestId] = { turnId, conversationId, origin: safeInt(row['origin'], 'chat_transport_request_origin_invalid', false) };
  }
  return out;
}

function parseNativeQuestion(value: unknown): IdentityState['nativeQuestion'] {
  if (value === null) return null;
  const row = object(value, 'chat_transport_native_question_invalid');
  return {
    messageId: requiredString(row['messageId'], 'chat_transport_native_question_id_invalid'),
    origin: safeInt(row['origin'], 'chat_transport_native_question_origin_invalid', false)
  };
}

function parseMeta(raw: unknown, directoryId: string): SessionMeta | null {
  const value = object(raw, 'chat_transport_meta_invalid');
  if (value['id'] !== directoryId) throw new Error('chat_transport_session_id_mismatch');
  if (value['conversationId'] === null) return null;
  const origin = value['origin'];
  if (origin !== null && origin !== undefined) {
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
    const row = origin as JsonObject;
    const kind = row['kind'];
    if (kind === 'worker' || kind === 'helper') return null;
    if (kind !== 'resume' && kind !== 'desktop') return null;
    const fromSessionId = row['fromSessionId'];
    const agentId = row['agentId'];
    if (fromSessionId !== null && typeof fromSessionId !== 'string') return null;
    if (agentId !== null && typeof agentId !== 'string') return null;
    if (typeof row['task'] !== 'string') return null;
  }
  const conversationId = requiredString(value['conversationId'], 'chat_transport_conversation_invalid', 256);
  if (!CHAT_ID.test(conversationId)) throw new Error('chat_transport_conversation_invalid');
  if (!Array.isArray(value['chatIds']) || value['chatIds'].length === 0 || value['chatIds'].length > 128) throw new Error('chat_transport_chat_ids_invalid');
  const chatIds = value['chatIds'].map((entry) => requiredString(entry, 'chat_transport_chat_id_invalid', 256));
  if (!chatIds.every((entry) => CHAT_ID.test(entry)) || chatIds.at(-1) !== conversationId) throw new Error('chat_transport_current_conversation_invalid');
  if (value['timelineTurns'] === undefined || value['requestTurns'] === undefined || value['nativeQuestion'] === undefined || value['__canonicalProjection'] !== 1) {
    throw new Error('chat_transport_projection_unsupported');
  }
  const activeTurnId = nullableString(value['activeTurnId'], 'chat_transport_active_turn_invalid');
  if (activeTurnId !== null && !CHAT_ID.test(activeTurnId)) throw new Error('chat_transport_active_turn_invalid');
  const committed = nullableString(value['lastCommittedResumeHandoffId'], 'chat_transport_resume_handoff_invalid', 64);
  if (committed !== null && !SESSION_ID.test(committed)) throw new Error('chat_transport_resume_handoff_invalid');
  return {
    id: directoryId,
    title: typeof value['title'] === 'string' && value['title'].trim() ? value['title'].slice(0, 240) : 'ChatGPT conversation',
    conversationId,
    chatIds,
    updatedAt: safeInt(value['updatedAt'], 'chat_transport_updated_at_invalid'),
    activeTurnId,
    lastCommittedResumeHandoffId: committed,
    historySeq: safeInt(value['__historySeq'], 'chat_transport_history_seq_invalid'),
    timelineTurns: parseTimelineTurns(value['timelineTurns']),
    requestTurns: parseRequestTurns(value['requestTurns']),
    nativeQuestion: parseNativeQuestion(value['nativeQuestion'])
  };
}

function parseStoredText(value: unknown): { text: string; truncated: boolean; chars: number } {
  const row = object(value, 'chat_transport_text_invalid');
  if (typeof row['text'] !== 'string' || row['text'].length > MAX_TEXT || typeof row['truncated'] !== 'boolean') throw new Error('chat_transport_text_invalid');
  const chars = safeInt(row['chars'], 'chat_transport_chars_invalid');
  if (row['truncated'] === false && chars !== row['text'].length) throw new Error('chat_transport_chars_mismatch');
  if (row['truncated'] === true && chars < row['text'].length) throw new Error('chat_transport_chars_mismatch');
  return { text: row['text'], truncated: row['truncated'], chars };
}

function canonicalKey(event: JsonObject): string | null {
  if ((event['kind'] === 'user_message' || event['kind'] === 'assistant_message') && typeof event['messageId'] === 'string') {
    return String(event['kind']) + '\0' + event['messageId'];
  }
  if (event['kind'] === 'tool_call' && event['call'] && typeof event['call'] === 'object' && !Array.isArray(event['call'])) {
    const callId = (event['call'] as JsonObject)['callId'];
    return typeof callId === 'string' && callId ? 'tool_call\0' + callId : null;
  }
  if (event['kind'] === 'native_image' && typeof event['messageId'] === 'string' && typeof event['providerAssetId'] === 'string') {
    return 'native_image\0' + event['messageId'] + '\0' + event['providerAssetId'];
  }
  return null;
}

function parseCanonicalMessage(event: JsonObject, key: string): CanonicalMessage | null {
  const kind = event['kind'];
  if (kind !== 'user_message' && kind !== 'assistant_message') return null;
  const messageId = requiredString(event['messageId'], 'chat_transport_message_id_invalid');
  const seq = safeInt(event['seq'], 'chat_transport_message_seq_invalid', false);
  const origin = event['origin'] === undefined ? seq : safeInt(event['origin'], 'chat_transport_message_origin_invalid', false);
  if (origin > seq) throw new Error('chat_transport_message_origin_invalid');
  const turnId = optionalString(event['turnId'], 'chat_transport_message_turn_invalid');
  if (turnId && !CHAT_ID.test(turnId) && !FALLBACK_MESSAGE_TURN_ID.test(turnId)) {
    throw new Error('chat_transport_message_turn_invalid');
  }
  const providerMessageId = optionalString(event['providerMessageId'], 'chat_transport_provider_message_invalid');
  const inputId = optionalString(event['inputId'], 'chat_transport_input_id_invalid');
  const inputDelivery = event['inputDelivery'];
  if (inputDelivery !== undefined && inputDelivery !== 'offered' && inputDelivery !== 'confirmed') {
    throw new Error('chat_transport_input_delivery_invalid');
  }
  const source = event['source'];
  if (source !== 'extension' && source !== 'mcp' && source !== 'app') throw new Error('chat_transport_message_source_invalid');
  const agent = optionalString(event['agent'], 'chat_transport_agent_invalid', 128);
  const authoredText = event['authoredText'] === undefined
    ? undefined
    : requiredString(event['authoredText'], 'chat_transport_authored_text_invalid', MAX_TEXT);
  const authoredAt = event['authoredAt'] === undefined
    ? undefined
    : safeInt(event['authoredAt'], 'chat_transport_authored_at_invalid');
  const attachments = kind === 'user_message' && event['attachments'] !== undefined
    ? (() => {
        if (!Array.isArray(event['attachments']) || event['attachments'].length > 10) {
          throw new Error('chat_transport_attachments_invalid');
        }
        return event['attachments'].map((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('chat_transport_attachment_invalid');
          const file = raw as JsonObject;
          const id = requiredString(file['id'], 'chat_transport_attachment_id_invalid', 100);
          const name = requiredString(file['name'], 'chat_transport_attachment_name_invalid', 200);
          // DOM-only screenshot observations intentionally use size=0 because the page proves
          // rendered pixels, not the provider file byte count. Zero is therefore "unknown",
          // not malformed. Provider-backed attachments may still carry their exact positive size.
          const size = safeInt(file['size'], 'chat_transport_attachment_size_invalid');
          if (size > 512 * 1024 * 1024) throw new Error('chat_transport_attachment_size_invalid');
          const mimeType = requiredString(file['mimeType'], 'chat_transport_attachment_mime_invalid', 100);
          if (!/^image\/[a-z0-9.+-]{1,80}$/i.test(mimeType)) throw new Error('chat_transport_attachment_mime_invalid');
          const preview = file['preview'] === undefined
            ? undefined
            : requiredString(file['preview'], 'chat_transport_attachment_preview_invalid', 32_768);
          if (preview !== undefined && !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(preview)) {
            throw new Error('chat_transport_attachment_preview_invalid');
          }
          return { id, name, size, mimeType, ...(preview ? { preview } : {}) };
        });
      })()
    : undefined;
  const base: CanonicalMessage = {
    key, kind, source, messageId, seq, origin,
    time: safeInt(event['time'], 'chat_transport_message_time_invalid'),
    ...(authoredAt === undefined ? {} : { authoredAt }),
    ...(authoredText === undefined ? {} : { authoredText }),
    ...(agent ? { agent } : {}),
    ...(turnId ? { turnId } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(inputId ? { inputId } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(kind === 'user_message' && (inputDelivery === 'offered' || inputDelivery === 'confirmed')
      ? { inputDelivery }
      : {}),
    ...parseStoredText(event['message'])
  };
  if (kind === 'user_message') return base;
  if (event['state'] !== undefined && event['state'] !== 'streaming' && event['state'] !== 'final') throw new Error('chat_transport_message_state_invalid');
  if (typeof event['final'] !== 'boolean') throw new Error('chat_transport_message_final_invalid');
  if (event['state'] === 'streaming' && event['final'] === true) throw new Error('chat_transport_message_state_conflict');
  const finalContentSeq = event['finalContentSeq'] === undefined ? undefined : safeInt(event['finalContentSeq'], 'chat_transport_final_content_seq_invalid', false);
  return {
    ...base,
    state: event['state'] === 'final' || event['final'] === true ? 'final' : 'streaming',
    ...(finalContentSeq === undefined ? {} : { finalContentSeq })
  };
}

function parseCanonicalIdentityTool(event: JsonObject, key: string): CanonicalIdentityToolCall | null {
  if (event['kind'] !== 'tool_call' || event['source'] !== 'mcp') return null;
  const turnId = nullableString(event['turnId'], 'chat_transport_turn_id_invalid');
  const call = event['call'];
  if (!turnId || !CHAT_ID.test(turnId) || !call || typeof call !== 'object' || Array.isArray(call)) return null;
  const row = call as JsonObject;
  if (row['attribution'] !== 'request_id') return null;
  const requestId = nullableString(row['requestId'], 'chat_transport_request_id_invalid');
  const conversationId = nullableString(row['conversationId'], 'chat_transport_request_conversation_invalid');
  if (!requestId || !conversationId || !CHAT_ID.test(requestId) || !CHAT_ID.test(conversationId)) return null;
  const seq = safeInt(event['seq'], 'chat_transport_tool_seq_invalid', false);
  return {
    key,
    seq,
    time: safeInt(event['time'], 'chat_transport_tool_time_invalid'),
    kind: 'tool_call',
    turnId,
    request: { requestId, conversationId }
  };
}

function collapseProviderAliases(input: Map<string, CanonicalMessage>): Map<string, CanonicalMessage> {
  const out = new Map(input);
  const providers = new Map<string, Array<[string, CanonicalMessage]>>();
  for (const [key, event] of [...out].sort(([, a], [, b]) => a.origin - b.origin || a.seq - b.seq)) {
    if (event.kind !== 'assistant_message' || !event.providerMessageId) continue;
    const group = providers.get(event.providerMessageId) ?? [];
    group.push([key, event]);
    providers.set(event.providerMessageId, group);
  }
  for (const group of providers.values()) {
    if (group.length < 2) continue;
    const [firstKey, first] = group[0]!;
    let latest = first;
    let seq = first.seq;
    for (const [key, event] of group) {
      const latestFinal = latest.state === 'final';
      const eventFinal = event.state === 'final';
      if (latestFinal !== eventFinal ? eventFinal : event.seq > latest.seq) latest = event;
      seq = Math.max(seq, event.seq);
      out.delete(key);
    }
    out.set(firstKey, {
      ...latest,
      key: firstKey,
      messageId: first.messageId,
      origin: first.origin,
      time: first.time,
      seq,
      turnId: group.find(([, event]) => event.turnId)?.[1].turnId
    });
  }
  return out;
}

async function readCanonicalMessages(dir: string): Promise<{
  messages: CanonicalMessage[];
  identityTools: CanonicalIdentityToolCall[];
  canonicalKeys: Set<string>;
  maxSeq: number;
  toolActivity: NightBuildActivityCandidate[];
}> {
  const all = new Map<string, CanonicalMessage>();
  const identityTools = new Map<string, CanonicalIdentityToolCall>();
  const canonicalKeys = new Set<string>();
  const toolActivity: NightBuildActivityCandidate[] = [];
  let maxSeq = 0;
  try {
    const raw = object(await readJson(path.join(dir, 'messages.json'), MAX_LEGACY_CANONICAL_BYTES), 'chat_transport_legacy_messages_invalid');
    if (Object.keys(raw).length > MAX_CANONICAL_ROWS) throw new Error('chat_transport_canonical_limit');
    for (const [key, value] of Object.entries(raw)) {
      const event = object(value, 'chat_transport_canonical_message_invalid');
      const expected = canonicalKey(event);
      if (!expected || expected !== key) continue;
      canonicalKeys.add(key);
      const seq = safeInt(event['seq'], 'chat_transport_message_seq_invalid', false);
      maxSeq = Math.max(maxSeq, seq);
      const message = parseCanonicalMessage(event, key);
      if (message) all.set(key, message);
      const tool = parseCanonicalIdentityTool(event, key);
      if (tool) identityTools.set(key, tool);
      const activity = parseNightBuildActivityCandidate(event, 'canonical');
      if (activity) toolActivity.push(activity);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const shards = path.join(dir, 'messages');
  let names: string[] = [];
  try { names = (await fs.readdir(shards)).filter((name) => MESSAGE_FILE.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (names.length > MAX_CANONICAL_ROWS) throw new Error('chat_transport_canonical_limit');
  for (let offset = 0; offset < names.length; offset += 32) {
    const batch = await Promise.all(names.slice(offset, offset + 32).map(async (name) => {
      const event = object(await readJson(path.join(shards, name), MAX_CANONICAL_BYTES), 'chat_transport_canonical_message_invalid');
      const key = canonicalKey(event);
      if (!key) throw new Error('chat_transport_canonical_key_invalid');
      if (createHash('sha256').update(key).digest('hex') + '.json' !== name) throw new Error('chat_transport_message_hash_mismatch');
      const seq = safeInt(event['seq'], 'chat_transport_message_seq_invalid', false);
      return {
        key,
        seq,
        message: parseCanonicalMessage(event, key),
        tool: parseCanonicalIdentityTool(event, key),
        activity: parseNightBuildActivityCandidate(event, 'canonical')
      };
    }));
    for (const row of batch) {
      canonicalKeys.add(row.key);
      maxSeq = Math.max(maxSeq, row.seq);
      if (row.message) all.set(row.key, row.message);
      if (row.tool) identityTools.set(row.key, row.tool);
      if (row.activity) toolActivity.push(row.activity);
    }
  }
  const collapsed = collapseProviderAliases(all);
  return {
    messages: [...collapsed.values()].sort((a, b) => a.origin - b.origin || a.seq - b.seq),
    identityTools: [...identityTools.values()],
    canonicalKeys,
    maxSeq,
    toolActivity
  };
}

function parseOutcome(value: unknown): NightBuildChatTurnOutcome {
  if (typeof value !== 'string' || !OUTCOMES.includes(value as NightBuildChatTurnOutcome)) throw new Error('chat_transport_turn_outcome_invalid');
  return value as NightBuildChatTurnOutcome;
}

async function readJournal(dir: string, canonicalKeys: Set<string>): Promise<JournalSnapshot> {
  let raw = '';
  try { raw = await readBounded(path.join(dir, 'events.jsonl'), MAX_JOURNAL_BYTES, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { maxSeq: 0, activeTurnId: null, identityEvents: [], turnEnds: [], handoffs: [], toolActivity: [], progress: [] };
  }
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_JOURNAL_ROWS) throw new Error('chat_transport_journal_limit');
  let maxSeq = 0;
  let previousSeq = 0;
  let activeTurnId: string | null = null;
  const identityEvents: JournalIdentityEvent[] = [];
  const turnEnds: JournalSnapshot['turnEnds'] = [];
  const handoffs: JournalSnapshot['handoffs'] = [];
  const toolActivity: NightBuildActivityCandidate[] = [];
  const progress = new Map<string, JournalProgress>();
  for (const line of lines) {
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_LINE_BYTES) continue;
    try {
      const event = object(JSON.parse(line) as unknown, 'chat_transport_journal_event_invalid');
      const seq = safeInt(event['seq'], 'chat_transport_journal_seq_invalid', false);
      if (seq <= previousSeq) continue;
      const time = safeInt(event['time'], 'chat_transport_journal_time_invalid');
      const kind = event['kind'];
      const key = canonicalKey(event);
      if (kind === 'tool_call' && event['source'] === 'mcp') {
        const activity = parseNightBuildActivityCandidate(event, 'journal');
        if (activity) toolActivity.push(activity);
      }
      if (key && canonicalKeys.has(key)) {
        // Canonical message/tool shards are the authority for these rows. The
        // journal copy is intentionally ignored rather than allowed to move the
        // durable cursor based on a partially validated duplicate. Activity
        // still keeps the journal launch so a later process revision can fold
        // onto the original origin.
        continue;
      }
      let relevant = false;
      if (kind === 'turn_start') {
        const turnId = requiredString(event['turnId'], 'chat_transport_turn_id_invalid');
        if (!CHAT_ID.test(turnId)) throw new Error('chat_transport_turn_id_invalid');
        activeTurnId = turnId;
        identityEvents.push({ seq, time, kind, turnId });
        relevant = true;
      } else if (kind === 'turn_end') {
        const turnId = requiredString(event['turnId'], 'chat_transport_turn_id_invalid');
        if (!CHAT_ID.test(turnId)) throw new Error('chat_transport_turn_id_invalid');
        const outcome = parseOutcome(event['outcome']);
        if (activeTurnId === turnId) activeTurnId = null;
        identityEvents.push({ seq, time, kind, turnId, outcome });
        turnEnds.push({ seq, time, turnId, outcome });
        relevant = true;
      } else if (kind === 'handoff') {
        const handoffId = requiredString(event['handoffId'], 'chat_transport_handoff_id_invalid', 64);
        if (!SESSION_ID.test(handoffId)) throw new Error('chat_transport_handoff_id_invalid');
        identityEvents.push({ seq, time, kind, handoffId });
        handoffs.push({ seq, handoffId });
        relevant = true;
      } else if (kind === 'tool_call' && event['source'] === 'mcp') {
        const turnId = nullableString(event['turnId'], 'chat_transport_turn_id_invalid');
        const call = event['call'];
        if (!turnId || !CHAT_ID.test(turnId) || !call || typeof call !== 'object' || Array.isArray(call)) {
          throw new Error('chat_transport_tool_identity_invalid');
        }
        const row = call as JsonObject;
        if (row['attribution'] === 'request_id') {
          if (typeof row['requestId'] !== 'string' || typeof row['conversationId'] !== 'string' ||
              !CHAT_ID.test(row['requestId']) || !CHAT_ID.test(row['conversationId'])) {
            throw new Error('chat_transport_tool_identity_invalid');
          }
          identityEvents.push({
            seq,
            time,
            kind,
            turnId,
            request: { requestId: row['requestId'], conversationId: row['conversationId'] }
          });
          relevant = true;
        }
      } else if (kind === 'progress' && event['source'] === 'extension') {
        const progressId = requiredString(event['progressId'], 'chat_transport_progress_id_invalid', 240);
        if (!/^[A-Za-z0-9._:#-]+$/.test(progressId)) throw new Error('chat_transport_progress_id_invalid');
        const turnId = requiredString(event['turnId'], 'chat_transport_progress_turn_invalid');
        if (!CHAT_ID.test(turnId)) throw new Error('chat_transport_progress_turn_invalid');
        const origin = event['origin'] === undefined
          ? seq
          : safeInt(event['origin'], 'chat_transport_progress_origin_invalid', false);
        if (origin > seq) throw new Error('chat_transport_progress_origin_invalid');
        const body = parseStoredText(event['message']);
        const held = progress.get(progressId);
        if (held && (held.turnId !== turnId || held.origin !== origin)) {
          throw new Error('chat_transport_progress_identity_conflict');
        }
        progress.set(progressId, held
          ? { ...held, seq, ...body }
          : { progressId, origin, seq, time, turnId, ...body });
        relevant = true;
      }
      if (!relevant) continue;
      previousSeq = seq;
      maxSeq = Math.max(maxSeq, seq);
    } catch {
      // The installed recorder tolerates a torn/damaged line while retaining every
      // validated durable row around it. A read-only observer must do the same and,
      // critically, must not advance its cursor from an unvalidated line.
      continue;
    }
  }
  return { maxSeq, activeTurnId, identityEvents, turnEnds, handoffs, toolActivity, progress: [...progress.values()] };
}

function positionOf(event: { seq: number; origin?: number }): number {
  return typeof event.origin === 'number' && Number.isFinite(event.origin) ? event.origin : event.seq;
}

/**
 * Browser delivery recorded by recordDeliveredInput().
 * Tool handouts keep messageId `input:<id>` and must not become a native question.
 */
function confirmedNativeAppInput(message: CanonicalMessage): boolean {
  return message.kind === 'user_message'
    && message.source === 'app'
    && message.inputDelivery === 'confirmed'
    && !!message.inputId
    && !message.messageId.startsWith('input:');
}

function injectedUserMessage(event: CanonicalMessage, turns: Record<string, TimelineTurn>): boolean {
  if (event.kind !== 'user_message') return false;
  // Extension page rows and the confirmed app delivery of ChatGPT's own user
  // message are native questions. Offered rows, tool handouts, decision rows,
  // and every other app or mcp user message stay injected.
  if (event.source !== 'extension' && !confirmedNativeAppInput(event)) return true;
  return !!event.inputId && (
    event.messageId.startsWith('input:') ||
    (!!event.turnId && Object.hasOwn(turns, event.turnId))
  );
}

function eligibleNativeSendMessage(
  message: CanonicalMessage,
  inputId: string,
  lowerBoundOrigin: number,
  expectedMessageId?: string
): boolean {
  if (message.kind !== 'user_message' || message.origin < lowerBoundOrigin) return false;
  if (expectedMessageId) {
    if (message.messageId !== expectedMessageId) return false;
    if (message.source === 'extension') return !message.inputId || message.inputId === inputId;
    return confirmedNativeAppInput(message) && message.inputId === inputId;
  }
  if (message.inputId !== inputId) return false;
  if (message.source === 'extension') return true;
  return confirmedNativeAppInput(message);
}

function responseTurnId(turns: Record<string, TimelineTurn>, id: string): string {
  const turn = turns[id];
  const owner = turn?.responseTurnId;
  return owner && turns[owner] && turns[owner]!.origin < turn!.origin ? owner : id;
}

function overlappingRequestTurns(
  turns: Record<string, TimelineTurn>,
  left: string,
  right: string,
  requests: Record<string, RequestTurn | null>,
  requestId: string
): boolean {
  const first = responseTurnId(turns, left);
  const second = responseTurnId(turns, right);
  const a = turns[first];
  const b = turns[second];
  if (!a || !b || !a.questionId || a.questionId !== b.questionId) return false;
  if (first !== second && Object.entries(requests).some(([id, owner]) =>
    id !== requestId && owner && [first, second].includes(responseTurnId(turns, owner.turnId)))) return false;
  const earlier = a.origin <= b.origin ? a : b;
  const later = earlier === a ? b : a;
  return earlier.endOrigin === undefined || later.origin < earlier.endOrigin;
}

function recordedRequestTurn(
  requests: Record<string, RequestTurn | null>,
  requestId: string,
  conversationId: string
): RequestTurn | null | undefined {
  if (!Object.hasOwn(requests, requestId)) return undefined;
  const owner = requests[requestId];
  return owner && owner.conversationId === conversationId ? owner : null;
}

function applyTurnIdentity(state: IdentityState, event: CanonicalMessage | JournalIdentityEvent): void {
  const origin = positionOf(event);
  if ('messageId' in event && event.kind === 'user_message' && !injectedUserMessage(event, state.timelineTurns) &&
      (!state.nativeQuestion || origin > state.nativeQuestion.origin)) {
    state.nativeQuestion = { messageId: event.messageId, origin };
  }
  const turns = state.timelineTurns;
  if (event.kind === 'turn_start' && event.turnId && !Object.hasOwn(turns, event.turnId)) {
    turns[event.turnId] = {
      origin,
      time: event.time,
      ...(state.nativeQuestion ? { questionId: state.nativeQuestion.messageId } : {})
    };
  } else if (event.kind === 'turn_end' && event.turnId && turns[event.turnId]) {
    const start = turns[event.turnId]!;
    turns[event.turnId] = {
      ...start,
      endTime: Math.max(start.endTime ?? 0, event.time),
      endOrigin: Math.min(start.endOrigin ?? Infinity, origin)
    };
  }
  if (event.kind !== 'tool_call' || !event.turnId || !('request' in event) || !event.request) return;
  const requestId = event.request.requestId;
  const conversationId = event.request.conversationId;
  const held = recordedRequestTurn(state.requestTurns, requestId, conversationId);
  let owner = responseTurnId(turns, event.turnId);
  if (held && responseTurnId(turns, held.turnId) !== owner) {
    if (!overlappingRequestTurns(turns, held.turnId, owner, state.requestTurns, requestId)) {
      state.requestTurns[requestId] = null;
      return;
    }
    const prior = responseTurnId(turns, held.turnId);
    const earlier = turns[prior]!.origin <= turns[owner]!.origin ? prior : owner;
    const later = earlier === prior ? owner : prior;
    for (const [id, turn] of Object.entries(turns)) {
      if (id === later || turn.responseTurnId === later) turns[id] = { ...turn, responseTurnId: earlier };
    }
    owner = earlier;
  }
  if (held === null) return;
  if (held && held.turnId === owner && held.origin <= origin) return;
  state.requestTurns[requestId] = {
    turnId: owner,
    conversationId,
    origin: Math.min(held?.origin ?? Infinity, origin)
  };
}

function rebuildIdentity(
  messages: CanonicalMessage[],
  identityTools: CanonicalIdentityToolCall[],
  journal: JournalSnapshot
): IdentityState {
  const state: IdentityState = { timelineTurns: {}, requestTurns: {}, nativeQuestion: null };
  const events: Array<CanonicalMessage | JournalIdentityEvent> = [
    ...messages.filter((message) => message.kind === 'user_message'),
    ...identityTools,
    ...journal.identityEvents.filter((event) => event.kind !== 'handoff')
  ];
  events.sort((a, b) => positionOf(a) - positionOf(b) || a.seq - b.seq);
  for (const event of events) applyTurnIdentity(state, event);
  return state;
}

function authoredTimeOf(message: CanonicalMessage): number {
  if (message.authoredAt !== undefined && message.authoredAt > 0) return message.authoredAt;
  if (message.kind !== 'assistant_message') return message.time;
  const match = /^assistant:([a-f0-9-]{36})?:([a-f0-9-]{36})?:(\d{13})$/i.exec(message.messageId);
  if (!match || (!match[1] && !match[2])) return message.time;
  const parsed = Number(match[3]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : message.time;
}

function assistantResponseKey(message: CanonicalMessage): string | undefined {
  if (message.kind !== 'assistant_message') return undefined;
  const parts = message.messageId.split(':');
  if (parts.length !== 4 || parts[0] !== 'assistant') return undefined;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const timestamped = /^\d{13}$/.test(parts[3]!);
  if (!timestamped && !uuid.test(parts[1]!)) return undefined;
  const working = parts[timestamped ? 1 : 2]!;
  const exchange = parts[timestamped ? 2 : 3]!;
  if (!uuid.test(working) || !uuid.test(exchange)) return undefined;
  return `${message.agent ?? ''}\0${working.toLowerCase()}:${exchange.toLowerCase()}`;
}

function projectAssistantResponseOrigins(
  messages: CanonicalMessage[],
  identity: IdentityState
): Map<string, number | null> {
  const responses = new Map<string, number | null>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const key = assistantResponseKey(message);
    if (!key) continue;
    const boundary = identity.timelineTurns[responseTurnId(identity.timelineTurns, message.turnId)]?.origin ?? null;
    if (!responses.has(key)) responses.set(key, boundary);
    else if (boundary === null || responses.get(key) !== boundary) responses.set(key, null);
  }
  return responses;
}

function continuationMarkerOf(text: string): { kind: 'HANDOFF' | 'RESUME'; token: string; marker: string } | null {
  const match = CONTINUATION_MARKER.exec(text) ?? CONTINUATION_MARKER_ESCAPED.exec(text.slice(0, 200));
  if (!match) return null;
  return { kind: match[1] as 'HANDOFF' | 'RESUME', token: match[2]!.replace(/\\/g, ''), marker: match[0] };
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!-/:-@\[-\x60{-~])/g, '$1');
}

function userPromptText(text: string): string | null {
  text = text.replace(/\r\n?/g, '\n');
  const identity = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  if (!header) return null;
  const end = identity.length + header[0].length + Number(header[1]);
  const boundary = '\n[[/COS_CONTEXT]]\n\n';
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

function visibleUserText(message: CanonicalMessage): string {
  if (message.kind !== 'user_message') return message.text;
  if (message.authoredText !== undefined) return message.authoredText;
  const candidate = message.text.trimStart();
  const unframed = userPromptText(candidate);
  if (unframed !== null) return unframed;
  const marker = continuationMarkerOf(candidate);
  const afterMarker = marker ? candidate.slice(marker.marker.trimEnd().length + 2) : candidate;
  if (afterMarker.startsWith('[[COS_CONTEXT:')) {
    throw new Error('chat_transport_user_prompt_frame_invalid');
  }
  return message.text;
}

function resumeBootstrapMatches(recorded: string, summary: string): boolean {
  const canonical = (value: string): string =>
    value.replace(/\u00c2\u00a0/g, ' ').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  const strip = (value: string): string => {
    const prompt = userPromptText(value) ?? value;
    const marker = continuationMarkerOf(prompt);
    const end = marker?.marker.trimEnd().length ?? 0;
    return marker?.kind === 'RESUME' && prompt === prompt.trimStart() && prompt.slice(end, end + 2) === '\n\n'
      ? prompt.slice(end + 2)
      : prompt;
  };
  const expected = canonical(
    'Continuing a Chat On Steroids session that was compacted. This is the brief the previous chat wrote about its own work; carry on from it rather than starting again.\n\n' +
    summary
  );
  const normalized = canonical(recorded);
  return strip(normalized) === expected || strip(unescapeMarkdown(normalized)) === expected;
}

async function walBoundary(userData: string, row: CatalogRow, messages: CanonicalMessage[]): Promise<number | null> {
  let raw: unknown | null;
  try { raw = await readOptionalJson(path.join(userData, 'state', 'continuations.json'), MAX_STATE_BYTES); }
  catch { return null; }
  if (raw === null) return null;
  let root: JsonObject;
  try { root = object(raw, 'chat_transport_continuations_invalid'); }
  catch { return null; }
  if (root['version'] !== 1 || !Array.isArray(root['entries']) || root['entries'].length > 2_000) return null;
  const candidates: number[] = [];
  for (const message of messages) {
    if (message.kind !== 'user_message' || message.truncated) continue;
    const marker = continuationMarkerOf(message.text);
    if (marker?.kind !== 'RESUME') continue;
    for (const candidate of root['entries']) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entry = candidate as JsonObject;
      if (entry['token'] !== marker.token || entry['state'] !== 'committed' || entry['sessionId'] !== row.directoryId ||
          entry['to'] !== row.meta.conversationId || entry['handoffId'] !== row.meta.lastCommittedResumeHandoffId) continue;
      const destination = entry['destinationSend'];
      if (!destination || typeof destination !== 'object' || Array.isArray(destination)) continue;
      const send = destination as JsonObject;
      if (send['state'] === 'sent' && send['conversationId'] === row.meta.conversationId && send['messageId'] === message.messageId) {
        candidates.push(message.origin);
      }
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length > 1) throw new Error('chat_transport_resume_boundary_ambiguous');
  return unique[0] ?? null;
}

async function handoffBoundary(row: CatalogRow, messages: CanonicalMessage[], journal: JournalSnapshot, dir: string): Promise<number> {
  const handoffId = row.meta.lastCommittedResumeHandoffId;
  if (!handoffId) throw new Error('chat_transport_resume_boundary_unproven');
  let handoffRaw: unknown;
  try { handoffRaw = await readJson(path.join(dir, 'handoffs', handoffId + '.json'), MAX_HANDOFF_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('chat_transport_resume_boundary_unproven');
    throw error;
  }
  const raw = object(handoffRaw, 'chat_transport_handoff_invalid');
  if (raw['id'] !== handoffId || raw['sessionId'] !== row.directoryId || typeof raw['text'] !== 'string' ||
      raw['text'].length === 0 || raw['text'].length > 512 * 1024) {
    throw new Error('chat_transport_handoff_invalid');
  }
  const handoffSeqs = journal.handoffs.filter((event) => event.handoffId === handoffId).map((event) => event.seq);
  if (handoffSeqs.length === 0) throw new Error('chat_transport_resume_boundary_unproven');
  const candidates = messages.filter((message) =>
    message.kind === 'user_message' &&
    !message.truncated &&
    handoffSeqs.some((seq) => seq < message.origin) &&
    resumeBootstrapMatches(message.text, raw['text'] as string)
  );
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1 ? 'chat_transport_resume_boundary_ambiguous' : 'chat_transport_resume_boundary_unproven');
  }
  return candidates[0]!.origin;
}

async function currentLowerBound(
  userData: string,
  row: CatalogRow,
  messages: CanonicalMessage[],
  journal: JournalSnapshot,
  dir: string
): Promise<number> {
  if (row.meta.chatIds.length <= 1) return 0;
  if (!row.meta.lastCommittedResumeHandoffId) throw new Error('chat_transport_resume_boundary_unproven');
  const wal = await walBoundary(userData, row, messages);
  if (wal !== null) return wal;
  return handoffBoundary(row, messages, journal, dir);
}

async function catalogRows(userData: string): Promise<CatalogRow[]> {
  let names: string[];
  try { names = (await fs.readdir(path.join(userData, 'sessions'))).filter((name) => SESSION_ID.test(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > MAX_SESSIONS) throw new Error('chat_transport_session_limit');
  const rows: CatalogRow[] = [];
  for (let offset = 0; offset < names.length; offset += 32) {
    const batch = await Promise.all(names.slice(offset, offset + 32).map(async (id): Promise<CatalogRow | null> => {
      try {
        const meta = parseMeta(await readJson(path.join(userData, 'sessions', id, 'meta.json'), MAX_META_BYTES), id);
        return meta ? { directoryId: id, meta } : null;
      } catch (error) {
        if ((error as Error).message === 'chat_transport_projection_unsupported') return null;
        throw error;
      }
    }));
    for (const row of batch) if (row) rows.push(row);
  }
  const ownership = new Map<string, number>();
  for (const row of rows) ownership.set(row.meta.conversationId, (ownership.get(row.meta.conversationId) ?? 0) + 1);
  return rows.filter((row) => ownership.get(row.meta.conversationId) === 1);
}

export function nightBuildChatConversationHandle(
  salt: string,
  sessionId: string,
  conversationId: string
): string {
  if (!salt) throw new Error('chat_transport_salt_missing');
  if (!SESSION_ID.test(sessionId) || !CHAT_ID.test(conversationId)) {
    throw new Error('chat_transport_conversation_invalid');
  }
  return opaque(salt, 'conversation', sessionId + '\0' + conversationId);
}

function conversationHandle(row: CatalogRow, salt: string): string {
  return nightBuildChatConversationHandle(salt, row.directoryId, row.meta.conversationId);
}

function publicConversation(row: CatalogRow, salt: string): NightBuildChatConversationV1 {
  return { handle: conversationHandle(row, salt), title: row.meta.title, updatedAt: row.meta.updatedAt };
}

async function catalogRowForHandle(userData: string, salt: string, handle: string): Promise<CatalogRow | null> {
  const matches = (await catalogRows(userData)).filter((row) => conversationHandle(row, salt) === handle);
  return matches.length === 1 ? matches[0]! : null;
}

async function catalogRowForIdentity(
  userData: string,
  sessionId: string,
  conversationId: string
): Promise<CatalogRow | null> {
  if (!SESSION_ID.test(sessionId) || !CHAT_ID.test(conversationId)) return null;
  let meta: SessionMeta | null;
  try {
    meta = parseMeta(
      await readJson(path.join(userData, 'sessions', sessionId, 'meta.json'), MAX_META_BYTES),
      sessionId
    );
  } catch (error) {
    if ((error as Error).message === 'chat_transport_projection_unsupported') return null;
    throw error;
  }
  if (!meta || meta.conversationId !== conversationId) return null;
  return { directoryId: sessionId, meta };
}

export async function resolveNightBuildChatConversation(
  userData: string,
  salt: string,
  handle: string
): Promise<NightBuildChatResolvedConversation | null> {
  if (!salt) throw new Error('chat_transport_salt_missing');
  const row = await catalogRowForHandle(userData, salt, handle);
  if (!row) return null;
  return {
    handle,
    sessionId: row.directoryId,
    conversationId: row.meta.conversationId,
    title: row.meta.title,
    updatedAt: row.meta.updatedAt
  };
}

/**
 * Resolve one Native Chat send to the recorder's exact native question and turn.
 * A same-text row is deliberately insufficient.
 *
 * An extension user row with the expected message id and no conflicting input id
 * remains proof. recordDeliveredInput() writes the same delivery as source app,
 * inputDelivery confirmed, the exact outbox id, and ChatGPT's own user-message id.
 * That row is the other eligible proof. Offered, tool-keyed, missing-input, and
 * any other app user row is not. One matching message and one turn whose
 * questionId equals that message id are still required.
 */
export async function resolveNightBuildChatNativeSendProof(
  userData: string,
  salt: string,
  handle: string,
  inputId: string,
  expectedMessageId?: string
): Promise<NightBuildChatNativeSendProof | null> {
  const row = await catalogRowForHandle(userData, salt, handle);
  if (!row) return null;
  // The exact native message id comes from the browser ACK after it witnessed
  // ChatGPT's newly-created user row. During generation the full transcript
  // projection intentionally rejects a snapshot if streaming metadata changes
  // across its reads. Acceptance proof does not need that whole projection: the
  // canonical user shard and append-only turn-start identity are immutable once
  // observed. Read only that durable identity slice so proof can settle while the
  // assistant is still streaming.
  if (expectedMessageId) {
    const dir = path.join(userData, 'sessions', row.directoryId);
    const canonical = await readCanonicalMessages(dir);
    const journal = await readJournal(dir, canonical.canonicalKeys);
    const lowerBoundOrigin = await currentLowerBound(userData, row, canonical.messages, journal, dir);
    const identity = rebuildIdentity(canonical.messages, canonical.identityTools, journal);
    const messages = canonical.messages.filter((message) =>
      eligibleNativeSendMessage(message, inputId, lowerBoundOrigin, expectedMessageId)
    );
    if (messages.length !== 1) return null;
    const message = messages[0]!;
    const turns = Object.entries(identity.timelineTurns).filter(([, turn]) => turn.questionId === message.messageId);
    if (turns.length !== 1) return null;
    const [turnId, turn] = turns[0]!;
    if (!turnId || turn.origin < lowerBoundOrigin) return null;
    const finalMeta = parseMeta(await readJson(path.join(dir, 'meta.json'), MAX_META_BYTES), row.directoryId);
    if (!finalMeta || finalMeta.conversationId !== row.meta.conversationId ||
        finalMeta.lastCommittedResumeHandoffId !== row.meta.lastCommittedResumeHandoffId) {
      throw new Error('chat_transport_projection_changed');
    }
    return {
      messageId: message.messageId,
      turnId,
      turnOrigin: turn.origin,
      revisionSeq: message.seq
    };
  }

  const projection = await selectedProjection(userData, row);
  const messages = projection.messages.filter((message) =>
    eligibleNativeSendMessage(message, inputId, projection.lowerBoundOrigin)
  );
  if (messages.length !== 1) return null;
  const message = messages[0]!;
  const turns = Object.entries(projection.identity.timelineTurns).filter(([, turn]) => turn.questionId === message.messageId);
  if (turns.length !== 1) return null;
  const [turnId, turn] = turns[0]!;
  if (!turnId || turn.origin < projection.lowerBoundOrigin) return null;
  return {
    messageId: message.messageId,
    turnId,
    turnOrigin: turn.origin,
    revisionSeq: message.seq
  };
}

export async function resolveNightBuildChatNativeSendProofByIdentity(
  userData: string,
  salt: string,
  sessionId: string,
  conversationId: string,
  inputId: string,
  expectedMessageId?: string
): Promise<NightBuildChatNativeSendProof | null> {
  const handle = await nightBuildChatHandleForIdentity(userData, salt, sessionId, conversationId);
  if (!handle) return null;
  return resolveNightBuildChatNativeSendProof(userData, salt, handle, inputId, expectedMessageId);
}

function projectedTurnOrigin(identity: IdentityState, turnId: string | undefined): number | null {
  if (!turnId) return null;
  return identity.timelineTurns[responseTurnId(identity.timelineTurns, turnId)]?.origin ?? null;
}

function projectedQuestionOrigin(identity: IdentityState, messageId: string): number | null {
  for (const turn of Object.values(identity.timelineTurns)) {
    if (turn.questionId === messageId) return turn.origin;
  }
  return null;
}

function currentTurn(projection: SelectedProjection): NightBuildChatCurrentTurnV1 {
  const activeTurnId = projection.identitySource === 'rebuilt'
    ? projection.journal.activeTurnId
    : projection.row.meta.activeTurnId;
  const activeOrigin = activeTurnId
    ? projectedTurnOrigin(projection.identity, activeTurnId)
    : null;
  if (activeTurnId && activeOrigin !== null && activeOrigin >= projection.lowerBoundOrigin) {
    const terminal = projection.journal.turnEnds
      .filter((event) => event.turnId === activeTurnId)
      .sort((a, b) => b.seq - a.seq)[0];
    if (terminal) {
      return {
        state: 'terminal',
        outcome: terminal.outcome,
        endedAt: terminal.time,
        turnOrigin: activeOrigin
      };
    }
  }
  if (activeOrigin !== null && activeOrigin >= projection.lowerBoundOrigin) {
    return { state: 'generating', turnOrigin: activeOrigin };
  }
  let latest: { seq: number; time: number; outcome: NightBuildChatTurnOutcome; turnOrigin: number } | null = null;
  for (const event of projection.journal.turnEnds) {
    const origin = projectedTurnOrigin(projection.identity, event.turnId);
    if (origin === null || origin < projection.lowerBoundOrigin) continue;
    if (!latest || event.seq > latest.seq) latest = { seq: event.seq, time: event.time, outcome: event.outcome, turnOrigin: origin };
  }
  return latest
    ? { state: 'terminal', outcome: latest.outcome, endedAt: latest.time, turnOrigin: latest.turnOrigin }
    : { state: 'idle' };
}

function publicItem(message: CanonicalMessage, projection: SelectedProjection, salt: string): NightBuildChatTranscriptItemV1 {
  const response = assistantResponseKey(message);
  const turnOrigin = message.turnId ? projectedTurnOrigin(projection.identity, message.turnId) : null;
  const projectedOrigin = turnOrigin ?? (
    message.kind === 'user_message'
      ? projectedQuestionOrigin(projection.identity, message.messageId)
      : response
        ? projection.assistantResponseOrigins.get(response) ?? null
        : null
  );
  const text = visibleUserText(message);
  let assistantState = message.state ?? 'streaming';
  if (message.kind === 'assistant_message' && message.turnId) {
    const ended = projection.journal.turnEnds.some((event) => event.turnId === message.turnId);
    if (ended) {
      const latestForTurn = projection.messages
        .filter((candidate) => candidate.kind === 'assistant_message' && candidate.turnId === message.turnId)
        .sort((a, b) => b.seq - a.seq)[0];
      if (latestForTurn?.key === message.key) assistantState = 'final';
    }
  }
  return {
    itemId: opaque(salt, 'message', message.key),
    role: message.kind === 'user_message' ? 'user' : 'assistant',
    originSeq: message.origin,
    revisionSeq: message.seq,
    authoredAt: authoredTimeOf(message),
    turnOrigin: projectedOrigin,
    text,
    truncated: message.truncated,
    chars: message.kind === 'user_message' && text !== message.text ? text.length : message.chars,
    ...(message.kind === 'user_message' && message.attachments?.length
      ? { attachments: message.attachments.map((file) => ({
          attachmentId: opaque(salt, 'attachment', `${message.key}\0${file.id}`),
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          ...(file.preview ? { preview: file.preview } : {})
        })) }
      : {}),
    ...(message.kind === 'assistant_message'
      ? { state: assistantState, ...(message.finalContentSeq === undefined ? {} : { finalContentSeq: message.finalContentSeq }) }
      : {})
  };
}

/** Public visible commentary, carried as non-final assistant transcript text. */
function publicProgress(
  row: JournalProgress,
  projection: SelectedProjection,
  salt: string
): NightBuildChatTranscriptItemV1 | null {
  const turnOrigin = projectedTurnOrigin(projection.identity, row.turnId);
  if (turnOrigin === null || turnOrigin < projection.lowerBoundOrigin || row.origin < projection.lowerBoundOrigin) return null;
  // If the provider later exposes this exact public text canonically, prefer that stronger
  // identity instead of showing the same visible sentence twice.
  const duplicate = projection.messages.some((message) =>
    message.kind === 'assistant_message' &&
    projectedTurnOrigin(projection.identity, message.turnId) === turnOrigin &&
    message.text.trim() === row.text.trim()
  );
  if (duplicate) return null;
  return {
    itemId: opaque(salt, 'progress', `${projection.row.directoryId}\0${row.progressId}`),
    role: 'assistant',
    originSeq: row.origin,
    revisionSeq: row.seq,
    authoredAt: row.time,
    turnOrigin,
    text: row.text,
    truncated: row.truncated,
    chars: row.chars,
    state: 'streaming'
  };
}

async function selectedProjection(userData: string, row: CatalogRow): Promise<SelectedProjection> {
  const dir = path.join(userData, 'sessions', row.directoryId);
  const before = parseMeta(await readJson(path.join(dir, 'meta.json'), MAX_META_BYTES), row.directoryId);
  if (!before || before.conversationId !== row.meta.conversationId) throw new Error('chat_transport_projection_changed');
  const canonical = await readCanonicalMessages(dir);
  const journal = await readJournal(dir, canonical.canonicalKeys);
  const highWaterSeq = Math.max(canonical.maxSeq, journal.maxSeq);
  const after = parseMeta(await readJson(path.join(dir, 'meta.json'), MAX_META_BYTES), row.directoryId);
  if (!after || after.conversationId !== before.conversationId || after.historySeq !== before.historySeq ||
      after.updatedAt !== before.updatedAt || after.lastCommittedResumeHandoffId !== before.lastCommittedResumeHandoffId) {
    throw new Error('chat_transport_projection_changed');
  }
  const stableRow: CatalogRow = { directoryId: row.directoryId, meta: after };
  const identitySource: SelectedProjection['identitySource'] = after.historySeq === highWaterSeq ? 'metadata' : 'rebuilt';
  const identity: IdentityState = identitySource === 'metadata'
    ? { timelineTurns: after.timelineTurns, requestTurns: after.requestTurns, nativeQuestion: after.nativeQuestion }
    : rebuildIdentity(canonical.messages, canonical.identityTools, journal);
  const assistantResponseOrigins = projectAssistantResponseOrigins(canonical.messages, identity);
  const lowerBoundOrigin = await currentLowerBound(userData, stableRow, canonical.messages, journal, dir);
  const finalMeta = parseMeta(await readJson(path.join(dir, 'meta.json'), MAX_META_BYTES), row.directoryId);
  if (!finalMeta || finalMeta.conversationId !== after.conversationId || finalMeta.historySeq !== after.historySeq ||
      finalMeta.updatedAt !== after.updatedAt || finalMeta.lastCommittedResumeHandoffId !== after.lastCommittedResumeHandoffId) {
    throw new Error('chat_transport_projection_changed');
  }
  return {
    row: { directoryId: row.directoryId, meta: finalMeta },
    messages: canonical.messages,
    journal,
    identity,
    identitySource,
    lowerBoundOrigin,
    highWaterSeq,
    assistantResponseOrigins,
    toolActivity: [...canonical.toolActivity, ...journal.toolActivity]
  };
}

async function transcriptForRow(
  userData: string,
  salt: string,
  row: CatalogRow,
  query: NightBuildChatTranscriptQuery
): Promise<Omit<NightBuildChatTranscriptV1, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>> {
  const projection = await selectedProjection(userData, row);
  const activity = projectNightBuildToolActivity(
    projection.toolActivity,
    {
      conversationId: projection.row.meta.conversationId,
      lowerBoundOrigin: projection.lowerBoundOrigin,
      turnOrigin: (turnId) => projectedTurnOrigin(projection.identity, turnId),
      requestTurn: (requestId) => {
        if (!Object.hasOwn(projection.identity.requestTurns, requestId)) return undefined;
        const owner = projection.identity.requestTurns[requestId];
        return owner && owner.conversationId === projection.row.meta.conversationId ? owner : null;
      }
    },
    salt,
    os.homedir()
  );
  const messages = projection.messages.filter((message) => message.origin >= projection.lowerBoundOrigin);
  const progress = projection.journal.progress
    .map((entry) => publicProgress(entry, projection, salt))
    .filter((entry): entry is NightBuildChatTranscriptItemV1 => entry !== null);
  type PageRow = {
    origin: number;
    revision: number;
    item?: NightBuildChatTranscriptItemV1;
    activity?: NightBuildChatActivityItemV1;
  };
  const timeline: PageRow[] = [
    ...messages.map((message) => {
      const item = publicItem(message, projection, salt);
      return { origin: item.originSeq, revision: item.revisionSeq, item };
    }),
    ...progress.map((item) => ({ origin: item.originSeq, revision: item.revisionSeq, item })),
    ...activity.map((entry) => ({ origin: entry.originSeq, revision: entry.revisionSeq, activity: entry }))
  ];
  let selected: PageRow[];
  let mode: NightBuildChatTranscriptV1['page']['mode'];
  let hasEarlier = false;
  let hasMore = false;
  if (query.afterRevision !== undefined) {
    mode = 'incremental';
    const changed = timeline.filter((entry) => entry.revision > query.afterRevision!)
      .sort((a, b) => a.revision - b.revision || a.origin - b.origin);
    selected = changed.slice(0, query.limit);
    hasMore = changed.length > selected.length;
  } else if (query.beforeOrigin !== undefined) {
    mode = 'backfill';
    const earlier = timeline.filter((entry) => entry.origin < query.beforeOrigin!)
      .sort((a, b) => a.origin - b.origin || a.revision - b.revision);
    selected = earlier.slice(-query.limit);
    hasEarlier = earlier.length > selected.length;
  } else {
    mode = 'recent';
    const ordered = [...timeline].sort((a, b) => a.origin - b.origin || a.revision - b.revision);
    selected = ordered.slice(-query.limit);
    hasEarlier = ordered.length > selected.length;
  }
  const items = selected.flatMap((entry) => entry.item ? [entry.item] : []);
  const pageActivity = selected.flatMap((entry) => entry.activity ? [entry.activity] : []);
  const origins = selected.map((entry) => entry.origin);
  return {
    conversation: {
      handle: query.conversation,
      title: projection.row.meta.title,
      updatedAt: projection.row.meta.updatedAt
    },
    projection: {
      current: true,
      identitySource: projection.identitySource,
      lowerBoundOrigin: projection.lowerBoundOrigin,
      observedHighWaterSeq: projection.highWaterSeq,
      metadataHighWaterSeq: projection.row.meta.historySeq
    },
    page: {
      mode,
      hasEarlier,
      hasMore,
      earliestOrigin: origins.length ? Math.min(...origins) : null,
      latestRevision: selected.reduce((max, entry) => Math.max(max, entry.revision), query.afterRevision ?? 0)
    },
    currentTurn: currentTurn(projection),
    items,
    activity: pageActivity
  };
}

/**
 * In-process fast path after the session store has already resolved the opaque
 * handle to one exact current session + conversation.  The selected session's
 * durable metadata is still reread here and selectedProjection keeps its full
 * before/after/final fences, so this skips only the unrelated all-session scan.
 */
export async function readNightBuildChatTranscriptByIdentity(
  userData: string,
  salt: string,
  sessionId: string,
  conversationId: string,
  query: NightBuildChatTranscriptQuery
): Promise<Omit<NightBuildChatTranscriptV1, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>> {
  const expectedHandle = nightBuildChatConversationHandle(salt, sessionId, conversationId);
  if (expectedHandle !== query.conversation) throw new Error('chat_transport_conversation_not_found');
  const row = await catalogRowForIdentity(userData, sessionId, conversationId);
  if (!row) throw new Error('chat_transport_conversation_not_found');
  return transcriptForRow(userData, salt, row, query);
}

export function createNightBuildChatTransportSource(userData: string, salt: string): NightBuildChatTransportDataSource {
  if (!salt) throw new Error('chat_transport_salt_missing');
  return {
    async list() {
      return (await catalogRows(userData))
        .map((row) => publicConversation(row, salt))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 200);
    },
    async transcript(query) {
      const rows = await catalogRows(userData);
      const matches = rows.filter((row) => conversationHandle(row, salt) === query.conversation);
      if (matches.length !== 1) throw new Error('chat_transport_conversation_not_found');
      return transcriptForRow(userData, salt, matches[0]!, query);
    }
  };
}
