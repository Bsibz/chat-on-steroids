import { createHash } from 'node:crypto';

import type { NightBuildChatConversationListV1, NightBuildChatTranscriptV1 } from '../shared/night-build-chat-transport-v1.js';
import type {
  NightBuildChatSendCreateV2,
  NightBuildChatSendIntentV2,
  NightBuildChatStopCreateV2,
  NightBuildChatStopIntentV2
} from '../shared/night-build-chat-transport-v2.js';
import type { TurnOutcome } from '../shared/session.js';
import { getConfig } from './config.js';
import { nativeChatStopPending, requestNativeChatStop, startBridge, STOP_COMMAND_TIMEOUT_MS } from './bridge.js';
import { readDurable, writeDurableNow } from './durable.js';
import { continuationForSession } from './session/continuation.js';
import {
  assertNativeChatInputReady,
  beginNativeChatStopMutation,
  clearNativeChatStopMutation,
  enqueueAdmittedNativeChatInput,
  listInputs,
  recordNativeChatAcceptance,
  setNativeChatStopExpiry
} from './session/input.js';
import { getSession, readTurnEnd, withSessionMutationAdmission } from './session/store.js';
import {
  createNightBuildChatTransportSource,
  nightBuildChatHandleForIdentity,
  resolveNightBuildChatConversation,
  resolveNightBuildChatNativeSendProofByIdentity,
  type NightBuildChatTranscriptQuery
} from './night-build-chat-transport-source.js';

export interface NightBuildChatTransportV2DataSource {
  list(): Promise<NightBuildChatConversationListV1['conversations']>;
  transcript(query: NightBuildChatTranscriptQuery): Promise<Omit<NightBuildChatTranscriptV1, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>>;
  createSend(input: NightBuildChatSendCreateV2): Promise<Omit<NightBuildChatSendIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>>;
  send(id: string): Promise<Omit<NightBuildChatSendIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'> | null>;
  inspectSend(id: string): Promise<Omit<NightBuildChatSendIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'> | null>;
  createStop(input: NightBuildChatStopCreateV2): Promise<Omit<NightBuildChatStopIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>>;
  stop(id: string): Promise<Omit<NightBuildChatStopIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'> | null>;
}

function opaque(salt: string, domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(salt).update('\0').update(value).digest('base64url');
}

function sendError(row: Awaited<ReturnType<typeof listInputs>>[number]): NightBuildChatSendIntentV2['error'] {
  if (row.state === 'cancelled' && row.sendAuthorizedAt !== undefined) return 'acceptance_unknown';
  if (row.state === 'failed' || row.state === 'cancelled') return 'pre_send_failed';
  return null;
}

/** Internal classifier for exact durable turn terminal evidence. */
export function classifyNativeChatStopTerminalOutcome(
  outcome: TurnOutcome | null
): NightBuildChatStopIntentV2['state'] | null {
  if (outcome === 'stopped') return 'stopped';
  if (outcome === 'completed') return 'completed';
  if (outcome !== null) return 'unknown';
  return null;
}

const STOP_STATE = 'night-build-chat-stop-intents-v2';
const MAX_STOP_INTENTS = 256;
const STOP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
interface NativeStopRecord {
  id: string;
  sendId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  userMessageId: string;
  createdAt: number;
  queuedAt: number | null;
  error: 'turn_changed' | 'stop_unavailable' | null;
}

let stopSerial: Promise<void> = Promise.resolve();
async function withStopSerial<T>(operation: () => Promise<T>): Promise<T> {
  const before = stopSerial;
  let release!: () => void;
  stopSerial = new Promise<void>((resolve) => { release = resolve; });
  await before;
  try { return await operation(); }
  finally { release(); }
}

async function loadStops(): Promise<NativeStopRecord[]> {
  const raw = await readDurable<{ version: number; rows: NativeStopRecord[] }>(STOP_STATE);
  if (!raw) return [];
  if (raw.version !== 1 || !Array.isArray(raw.rows) || raw.rows.length > MAX_STOP_INTENTS * 2) throw new Error('native_stop_state_invalid');
  const now = Date.now();
  const valid = raw.rows.filter((row) => row && typeof row === 'object' &&
    typeof row.id === 'string' && typeof row.sendId === 'string' && typeof row.sessionId === 'string' &&
    typeof row.conversationId === 'string' && typeof row.turnId === 'string' && typeof row.userMessageId === 'string' &&
    Number.isFinite(row.createdAt) && now - row.createdAt <= STOP_RETENTION_MS &&
    (row.queuedAt === null || Number.isFinite(row.queuedAt)) &&
    (row.error === null || row.error === 'turn_changed' || row.error === 'stop_unavailable'));
  if (valid.length !== raw.rows.filter((row) => Number.isFinite(row?.createdAt) && now - row.createdAt <= STOP_RETENTION_MS).length) {
    throw new Error('native_stop_state_invalid');
  }
  return valid.slice(-MAX_STOP_INTENTS);
}

async function saveStops(rows: NativeStopRecord[]): Promise<void> {
  await writeDurableNow(STOP_STATE, { version: 1, rows: rows.slice(-MAX_STOP_INTENTS) });
}

export function createInProcessNightBuildChatTransportV2Source(
  userData: string,
  salt: string
): NightBuildChatTransportV2DataSource {
  const read = createNightBuildChatTransportSource(userData, salt);

  const sendStatus = async (id: string) => {
    const row = (await listInputs()).find((entry) => entry.id === id && entry.nativeChat);
    if (!row?.nativeChat || !row.sessionId) return null;
    const currentConversation = await nightBuildChatHandleForIdentity(
      userData,
      salt,
      row.nativeChat.sessionId,
      row.nativeChat.conversationId
    );
    const conversation = opaque(
      salt, 'conversation', row.nativeChat.sessionId + '\0' + row.nativeChat.conversationId
    );
    let proof = row.nativeChat.acceptance ?? (row.messageId && row.deliveredAt !== undefined
      ? await resolveNightBuildChatNativeSendProofByIdentity(
        userData,
        salt,
        row.nativeChat.sessionId,
        row.nativeChat.conversationId,
        row.id
      )
      : null);
    if (proof && !row.nativeChat.acceptance) {
      if (!await recordNativeChatAcceptance(
        row.id, row.nativeChat.sessionId, row.nativeChat.conversationId, proof
      )) {
        proof = null;
      }
    }

    const state: NightBuildChatSendIntentV2['state'] = proof
      ? 'nativeAcceptanceProved'
      : row.state === 'queued'
        ? 'queued'
        : row.state === 'browser' || row.state === 'sent'
          ? 'claimed'
          : row.state === 'cancelled' && row.sendAuthorizedAt !== undefined
            ? 'unknown'
            : 'failed';
    return {
      id: row.id,
      conversation,
      state,
      createdAt: row.createdAt,
      claimedAt: row.offeredAt ?? null,
      receipt: proof ? {
        userMessage: opaque(salt, 'user-message', row.nativeChat.sessionId + '\0' + proof.messageId),
        turn: opaque(salt, 'turn', row.nativeChat.sessionId + '\0' + proof.turnId),
        turnOrigin: proof.turnOrigin
      } : null,
      error: proof ? null : sendError(row) ??
        (currentConversation ? null : row.sendAuthorizedAt !== undefined ? 'acceptance_unknown' : 'conversation_unavailable')
    } satisfies Omit<NightBuildChatSendIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>;
  };

  const stopStatus = async (id: string) => {
    const row = (await loadStops()).find((entry) => entry.id === id);
    if (!row) return null;
    const conversation = opaque(salt, 'conversation', row.sessionId + '\0' + row.conversationId);
    const terminal = await readTurnEnd(row.sessionId, row.turnId);
    const outcome = terminal?.outcome ?? null;
    const terminalState = classifyNativeChatStopTerminalOutcome(outcome);
    const state: NightBuildChatStopIntentV2['state'] = terminalState
      ?? (row.error ? 'failed'
        : nativeChatStopPending(row.id) ? 'queued'
          : 'unknown');
    if (outcome !== null || state === 'failed') {
      await clearNativeChatStopMutation(row.sendId, row.id);
    }
    return {
      id: row.id,
      sendId: row.sendId,
      conversation,
      state,
      error: row.error ?? (state === 'unknown' ? 'stop_unknown' : null)
    } satisfies Omit<NightBuildChatStopIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>;
  };

  return {
    list: () => read.list(),
    transcript: (query) => read.transcript(query),
    async createSend(input) {
      // A lost HTTP response is reconciled by the original intent id before
      // fresh admission. The first accepted send may already have made this
      // chat busy, which must not turn an idempotent retry into a new failure.
      const existing = (await listInputs()).find((entry) => entry.id === input.id);
      if (existing) {
        if (!existing.nativeChat || existing.text !== input.text) {
          throw new Error('Native Chat intent id already belongs to different input');
        }
        const originalHandle = opaque(
          salt, 'conversation', existing.nativeChat.sessionId + '\0' + existing.nativeChat.conversationId
        );
        if (originalHandle !== input.conversation) {
          throw new Error('Native Chat intent id already belongs to different input');
        }
        const status = await sendStatus(input.id);
        if (!status) throw new Error('native_chat_intent_unavailable');
        return status;
      }
      if (getConfig().sessions.record !== true) throw new Error('native_chat_recording_required');
      const resolved = await resolveNightBuildChatConversation(userData, salt, input.conversation);
      if (!resolved) throw new Error('native_chat_conversation_unavailable');
      // Starting the existing authenticated browser bridge grants no new external
      // authority; it only lets the extension collect the already-durable pinned input.
      if (!await startBridge()) throw new Error('native_chat_browser_unavailable');
      const nativeInput = {
        id: input.id,
        sessionId: resolved.sessionId,
        conversationId: resolved.conversationId,
        text: input.text
      };
      // This preflight may flush recorder state. Keep it outside mutation admission;
      // final exact ownership is rechecked again while the session queue is owned.
      await assertNativeChatInputReady(nativeInput);
      const admitted = await withSessionMutationAdmission(resolved.sessionId, 'native chat send admission', async () => {
        const current = await resolveNightBuildChatConversation(userData, salt, input.conversation);
        if (!current || current.sessionId !== resolved.sessionId ||
            current.conversationId !== resolved.conversationId ||
            continuationForSession(resolved.sessionId)) {
          throw new Error('native_chat_conversation_busy');
        }
        // ensureOpen() has made this summary live before admission runs, so
        // getSession() is an in-memory read here and cannot re-enter the queue.
        const session = await getSession(resolved.sessionId);
        if (!session) throw new Error('native_chat_conversation_unavailable');
        return enqueueAdmittedNativeChatInput(nativeInput, session);
      });
      // POST proves only durable admission. Do not make the HTTP acknowledgement
      // wait on a projection that ChatGPT may be actively revising after the
      // browser picks the input up. Exact acceptance is upgraded exclusively by
      // the same-id status/inspect path once recorder proof exists.
      return {
        id: admitted.id,
        conversation: input.conversation,
        state: 'queued',
        createdAt: admitted.createdAt,
        claimedAt: null,
        receipt: null,
        error: null
      } satisfies Omit<NightBuildChatSendIntentV2, 'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'>;
    },
    send: sendStatus,
    inspectSend: sendStatus,
    async createStop(input) {
      return withStopSerial(async () => {
        const existing = (await loadStops()).find((row) => row.id === input.id);
        if (existing) {
          const status = await stopStatus(input.id);
          if (!status) throw new Error('native_chat_stop_unavailable');
          const currentSend = await sendStatus(existing.sendId);
          if (existing.sendId !== input.sendId || status.conversation !== input.conversation ||
              currentSend?.receipt?.turn !== input.turn || currentSend?.receipt?.userMessage !== input.userMessage) {
            throw new Error('native_stop_intent_conflict');
          }
          return status;
        }
        const send = await sendStatus(input.sendId);
        if (!send || send.state !== 'nativeAcceptanceProved' || !send.receipt ||
            send.conversation !== input.conversation || send.receipt.turn !== input.turn || send.receipt.userMessage !== input.userMessage) {
          throw new Error('native_chat_stop_turn_changed');
        }
        const inputRow = (await listInputs()).find((entry) => entry.id === input.sendId && entry.nativeChat);
        if (!inputRow?.nativeChat || !inputRow.sessionId) throw new Error('native_chat_stop_turn_changed');
        const proof = await resolveNightBuildChatNativeSendProofByIdentity(
          userData, salt, inputRow.nativeChat.sessionId, inputRow.nativeChat.conversationId, input.sendId
        );
        if (!proof) throw new Error('native_chat_stop_turn_changed');
        if (!inputRow.owner) throw new Error('native_chat_stop_turn_changed');
        if (!await startBridge()) throw new Error('native_chat_browser_unavailable');
        const record: NativeStopRecord = {
          id: input.id,
          sendId: input.sendId,
          sessionId: inputRow.nativeChat.sessionId,
          conversationId: inputRow.nativeChat.conversationId,
          turnId: proof.turnId,
          userMessageId: proof.messageId,
          createdAt: Date.now(),
          queuedAt: null,
          error: null
        };
        await withSessionMutationAdmission(record.sessionId, 'native chat stop admission', async () => {
          const session = await getSession(record.sessionId);
          if (!session || session.conversationId !== record.conversationId ||
              session.activeTurnId !== record.turnId || continuationForSession(record.sessionId)) {
            throw new Error('native_chat_stop_turn_changed');
          }
          const rows = await loadStops();
          if (rows.some((row) => row.sessionId === record.sessionId &&
              row.turnId === record.turnId && !row.error)) {
            throw new Error('native_chat_stop_already_pending');
          }
          if (!await beginNativeChatStopMutation(record.sendId, record.sessionId, record.conversationId, {
            intentId: record.id,
            turnId: record.turnId,
            userMessageId: record.userMessageId,
            expiresAt: record.createdAt + STOP_COMMAND_TIMEOUT_MS
          })) {
            throw new Error('native_chat_stop_turn_changed');
          }
          try {
            await saveStops([...rows, record]);
          } catch (error) {
            await clearNativeChatStopMutation(record.sendId, record.id);
            throw error;
          }
        });
        try {
          await requestNativeChatStop({
            intentId: record.id,
            sessionId: record.sessionId,
            conversationId: record.conversationId,
            turnId: record.turnId,
            userMessageId: record.userMessageId,
            browserOwner: inputRow.owner,
            persistMutationDeadline: (expiresAt) =>
              setNativeChatStopExpiry(record.sendId, record.id, expiresAt)
          });
          record.queuedAt = Date.now();
          await saveStops([...(await loadStops()).filter((row) => row.id !== record.id), record]);
        } catch (error) {
          const code = (error as Error).message;
          if (code === 'native_stop_dispatch_unknown') {
            // The strict command crossed the queue boundary and may have been
            // observed. Preserve unknown semantics and the exact expiry fence.
            record.error = null;
            await saveStops([...(await loadStops()).filter((row) => row.id !== record.id), record]);
          } else {
            record.error = code === 'active_turn_changed' ? 'turn_changed' : 'stop_unavailable';
            await saveStops([...(await loadStops()).filter((row) => row.id !== record.id), record]);
            await clearNativeChatStopMutation(record.sendId, record.id);
          }
          throw error;
        }
        const status = await stopStatus(input.id);
        if (!status) throw new Error('native_chat_stop_unavailable');
        return status;
      });
    },
    stop: (id) => withStopSerial(() => stopStatus(id))
  };
}
