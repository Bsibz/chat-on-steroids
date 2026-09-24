import { createHash } from 'node:crypto';
import type { InputAttachment } from '../shared/input.js';
import { responseTurnId } from '../shared/chronology.js';
import type {
  NightBuildChatConfiguredSendCreateV3,
  NightBuildChatControlStateV3,
  NightBuildChatFreshSendCreateV3,
  NightBuildChatFreshSendIntentV3
} from '../shared/night-build-chat-control-v3.js';
import type { NightBuildChatSendIntentV2 } from '../shared/night-build-chat-transport-v2.js';
import { getChatModels, startChatModelDiscovery } from './chat-models.js';
import { getConfig } from './config.js';
import type { NightBuildChatTransportV2DataSource } from './night-build-chat-transport-v2-source.js';
import {
  nightBuildChatHandleForIdentity,
  resolveNightBuildChatConversation,
  resolveNightBuildChatNativeSendProofByIdentity
} from './night-build-chat-transport-source.js';
import { stageInputAttachment } from './session/input-attachments.js';
import { cancelInput, enqueueInput, listInputs } from './session/input.js';
import { automaticCompactionAllowed, getSession, readSessionPlan } from './session/store.js';

type BareSendIntent = Omit<
  NightBuildChatSendIntentV2,
  'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'
>;
type BareFreshSendIntent = Omit<
  NightBuildChatFreshSendIntentV3,
  'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'
>;

export interface NightBuildChatControlV3DataSource {
  state(conversation: string): Promise<Omit<
    NightBuildChatControlStateV3,
    'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'
  >>;
  refreshModels(): Promise<void>;
  stageAttachment(name: string, bytes: Uint8Array): Promise<InputAttachment>;
  createSend(input: NightBuildChatConfiguredSendCreateV3): Promise<BareSendIntent>;
  send(id: string): Promise<BareSendIntent | null>;
  inspectSend(id: string): Promise<BareSendIntent | null>;
  cancelSend(id: string): Promise<BareSendIntent | null>;
  createFreshSend(input: NightBuildChatFreshSendCreateV3): Promise<BareFreshSendIntent>;
  freshSend(id: string): Promise<BareFreshSendIntent | null>;
  inspectFreshSend(id: string): Promise<BareFreshSendIntent | null>;
  cancelFreshSend(id: string): Promise<BareFreshSendIntent | null>;
}

function retainedAttachmentIds(rows: Awaited<ReturnType<typeof listInputs>>): Set<string> {
  return new Set(
    rows
      .filter((row) => !['sent', 'failed', 'cancelled'].includes(row.state))
      .flatMap((row) => row.attachments?.map((file) => file.id) ?? [])
  );
}

function validateConfiguredSelection(input: NightBuildChatConfiguredSendCreateV3): void {
  if (input.model === null) {
    if (input.reasoningEffort !== null) throw new Error('native_chat_model_unavailable');
    return;
  }
  const catalog = getChatModels();
  if (catalog.state !== 'ready') throw new Error('native_chat_model_catalog_unavailable');
  const selected = catalog.models.find((row) => row.id === input.model);
  if (!selected) throw new Error('native_chat_model_unavailable');
  if (input.reasoningEffort !== null && !selected.efforts.includes(input.reasoningEffort)) {
    throw new Error('native_chat_effort_unavailable');
  }
}

function opaque(salt: string, domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(salt).update('\0').update(value).digest('base64url');
}

function freshSendError(row: Awaited<ReturnType<typeof listInputs>>[number]): BareFreshSendIntent['error'] {
  if (row.state === 'cancelled' && row.sendAuthorizedAt !== undefined) return 'acceptance_unknown';
  if (row.state === 'failed' || row.state === 'cancelled') return 'pre_send_failed';
  return null;
}

export function createInProcessNightBuildChatControlV3Source(
  userData: string,
  salt: string,
  writable: NightBuildChatTransportV2DataSource
): NightBuildChatControlV3DataSource {
  const freshStatus = async (id: string): Promise<BareFreshSendIntent | null> => {
    const row = (await listInputs()).find((entry) =>
      entry.id === id && !!entry.freshSourceConversationId && !!entry.freshSourceHandle
    );
    if (!row?.sessionId) return null;
    const destinationConversation = row.conversationId
      ? await nightBuildChatHandleForIdentity(userData, salt, row.sessionId, row.conversationId)
      : null;
    let proof = null;
    if (destinationConversation && row.messageId && row.deliveredAt !== undefined && row.conversationId) {
      try {
        proof = await resolveNightBuildChatNativeSendProofByIdentity(
          userData,
          salt,
          row.sessionId,
          row.conversationId,
          row.id,
          row.messageId
        );
      } catch (error) {
        if ((error as Error).message !== 'chat_transport_projection_changed') throw error;
      }
    }
    const state: BareFreshSendIntent['state'] = proof
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
      destinationConversation,
      state,
      createdAt: row.createdAt,
      claimedAt: row.offeredAt ?? null,
      receipt: proof ? {
        userMessage: opaque(salt, 'user-message', row.sessionId + '\0' + proof.messageId),
        turn: opaque(salt, 'turn', row.sessionId + '\0' + proof.turnId),
        turnOrigin: proof.turnOrigin
      } : null,
      error: proof ? null : freshSendError(row)
    };
  };

  return {
    async state(conversation) {
      const resolved = await resolveNightBuildChatConversation(userData, salt, conversation);
      if (!resolved) throw new Error('native_chat_conversation_unavailable');
      const session = await getSession(resolved.sessionId);
      if (!session || session.conversationId !== resolved.conversationId) {
        throw new Error('native_chat_conversation_unavailable');
      }
      const activeTurnId = session.activeTurnId
        ? responseTurnId(session.timelineTurns, session.activeTurnId)
        : null;
      const activeTimeline = activeTurnId ? session.timelineTurns?.[activeTurnId] : null;
      const plan = await readSessionPlan(resolved.sessionId);
      const selected = session.selectedModel?.conversationId === resolved.conversationId
        ? {
            model: session.selectedModel.model,
            reasoningEffort: session.selectedModel.reasoningEffort ?? null,
            observedAt: session.selectedModel.observedAt
          }
        : null;
      const config = getConfig();
      const compactionAllowed = automaticCompactionAllowed(session);
      return {
        conversation,
        selectedModel: selected,
        activeTurn: activeTimeline
          ? { turnOrigin: activeTimeline.origin, startedAt: activeTimeline.time }
          : null,
        plan,
        modelCatalog: getChatModels(),
        context: {
          estimatedTokens: Math.max(0, session.contextTokens),
          configuredLimit: Math.max(0, config.sessions.limitTokens),
          configuredWarning: Math.max(0, config.sessions.advisoryTokens),
          autoCompaction: compactionAllowed && config.compaction.auto,
          autoCompactionAt: compactionAllowed && config.compaction.auto && config.compaction.autoTokens > 0
            ? config.compaction.autoTokens
            : null
        }
      };
    },
    async refreshModels() {
      await startChatModelDiscovery(true);
    },
    async stageAttachment(name, bytes) {
      return stageInputAttachment(
        { name, bytes },
        retainedAttachmentIds(await listInputs())
      );
    },
    async createSend(input) {
      validateConfiguredSelection(input);
      return writable.createSend(input);
    },
    send: (id) => writable.send(id),
    inspectSend: (id) => writable.inspectSend(id),
    async cancelSend(id) {
      const row = (await listInputs()).find((entry) => entry.id === id && !!entry.nativeChat && !entry.freshSourceConversationId);
      if (!row) return null;
      await cancelInput(id);
      return writable.send(id);
    },
    async createFreshSend(input) {
      validateConfiguredSelection({
        id: input.id,
        conversation: input.sourceConversation,
        text: input.text,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        attachments: input.attachments
      });
      const existing = (await listInputs()).find((entry) => entry.id === input.id);
      if (existing) {
        if (!existing.freshSourceConversationId || existing.freshSourceHandle !== input.sourceConversation ||
            existing.text !== input.text || existing.model !== input.model ||
            existing.reasoningEffort !== input.reasoningEffort ||
            JSON.stringify(existing.attachments ?? []) !== JSON.stringify(input.attachments)) {
          throw new Error('Native Chat intent id already belongs to different input');
        }
        const status = await freshStatus(input.id);
        if (!status) throw new Error('native_chat_intent_unavailable');
        return status;
      }
      if (getConfig().sessions.record !== true) throw new Error('native_chat_recording_required');
      const source = await resolveNightBuildChatConversation(userData, salt, input.sourceConversation);
      if (!source) throw new Error('native_chat_conversation_unavailable');
      const session = await getSession(source.sessionId);
      if (!session || session.conversationId !== source.conversationId ||
          session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
        throw new Error('native_chat_conversation_unavailable');
      }
      await enqueueInput({
        id: input.id,
        sessionId: null,
        freshSourceConversationId: source.conversationId,
        freshSourceHandle: input.sourceConversation,
        text: input.text,
        mode: 'auto',
        dueAt: Date.now(),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        ...(input.attachments.length ? { attachments: input.attachments } : {})
      });
      const status = await freshStatus(input.id);
      if (!status) throw new Error('native_chat_intent_unavailable');
      return status;
    },
    freshSend: freshStatus,
    inspectFreshSend: freshStatus,
    async cancelFreshSend(id) {
      const row = (await listInputs()).find((entry) =>
        entry.id === id && !!entry.freshSourceConversationId && !!entry.freshSourceHandle
      );
      if (!row) return null;
      await cancelInput(id);
      return freshStatus(id);
    }
  };
}
