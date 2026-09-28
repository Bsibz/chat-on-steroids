import { isProModel } from '../shared/chat-models.js';
import type {
  NightBuildChatOwnerModeV1,
  NightBuildChatOwnerStateV1
} from '../shared/night-build-chat-owner-control-v1.js';
import {
  cancelSessionCompactionNow,
  compactionPhaseOf,
  compactSession,
  conversationAutomationMode,
  goalWorkerChat,
  setAutomaticCompactionNow,
  setSessionAutomation
} from './bridge.js';
import { getConfig } from './config.js';
import {
  resolveNightBuildChatConversation,
  type NightBuildChatResolvedConversation
} from './night-build-chat-transport-source.js';
import { isChatBlocked } from './session/blocked-chats.js';
import { continuationForSession } from './session/continuation.js';
import { automaticCompactionAllowed, conversationWasSuperseded, getSession } from './session/store.js';

type BareOwnerState = Omit<
  NightBuildChatOwnerStateV1,
  'protocolVersion' | 'appVersion' | 'transportStartedAt' | 'observedAt'
>;

/**
 * The CoS half of the cross-app owner-control lane.
 *
 * Every method resolves the opaque Night Build handle to the exact session + conversation at
 * operation time and mutates only through the app's existing owners: `setAutomaticCompactionNow`
 * for the saved switch (with its durable Off cancellation), `setSessionAutomation` for the
 * per-chat Goal/Loop owner, `compactSession` for the manual ticket, and
 * `cancelSessionCompactionNow` for the durable abort. There is no second switch, objective or
 * continuation ledger here.
 */
export interface NightBuildChatOwnerControlV1DataSource {
  state(conversation: string): Promise<BareOwnerState>;
  setAutoCompaction(
    conversation: string,
    enabled: boolean
  ): Promise<BareOwnerState & { cancelledAutomatic: number }>;
  setMode(conversation: string, mode: NightBuildChatOwnerModeV1): Promise<BareOwnerState>;
  compact(conversation: string): Promise<BareOwnerState>;
  cancelCompaction(conversation: string): Promise<BareOwnerState & { cancelled: boolean }>;
}

/**
 * The caller's handle must still name this exact session and its current conversation.
 *
 * Superseded conversations fail closed: a chat the lineage already replaced can never regain
 * automation or compaction authority through a stale handle.
 */
async function currentConversation(
  userData: string,
  salt: string,
  conversation: string
): Promise<NightBuildChatResolvedConversation> {
  const resolved = await resolveNightBuildChatConversation(userData, salt, conversation);
  if (!resolved) throw new Error('native_chat_conversation_unavailable');
  const session = await getSession(resolved.sessionId);
  if (!session || session.conversationId !== resolved.conversationId) {
    throw new Error('native_chat_conversation_unavailable');
  }
  if (await conversationWasSuperseded(resolved.conversationId)) {
    throw new Error('native_chat_conversation_unavailable');
  }
  return resolved;
}

/** Revalidate around every awaited owner call; a moved handle never inherits the result. */
async function assertUnchanged(
  userData: string,
  salt: string,
  conversation: string,
  resolved: NightBuildChatResolvedConversation
): Promise<void> {
  const current = await resolveNightBuildChatConversation(userData, salt, conversation);
  if (!current || current.sessionId !== resolved.sessionId || current.conversationId !== resolved.conversationId) {
    throw new Error('native_chat_conversation_changed');
  }
}

async function projectOwnerState(
  conversation: string,
  resolved: NightBuildChatResolvedConversation
): Promise<BareOwnerState> {
  const session = await getSession(resolved.sessionId);
  if (!session || session.conversationId !== resolved.conversationId) {
    throw new Error('native_chat_conversation_changed');
  }
  const config = getConfig();
  const selected = session.selectedModel;
  const proExempt = !!selected && selected.conversationId === session.conversationId &&
    isProModel(selected.model, selected.reasoningEffort);
  const mode = conversationAutomationMode(resolved.conversationId);
  const ticket = continuationForSession(resolved.sessionId);
  return {
    conversation,
    autoCompaction: {
      configured: config.compaction.auto,
      // Configured AND this exact chat's model/role is eligible, before the live
      // threshold/work gates that decide whether a ticket is actually filed.
      effective: automaticCompactionAllowed(session),
      exemption: config.compaction.auto && proExempt ? 'pro' : null,
      // Local recorder trigger in locally estimated units — never provider context occupancy.
      triggerTokens: Math.max(0, config.compaction.autoTokens)
    },
    mode: mode.mode,
    blocked: mode.blocked,
    compaction: {
      active: ticket !== null,
      state: ticket ? ticket.state : 'none',
      automatic: ticket?.automatic ?? false,
      phase: ticket ? compactionPhaseOf(ticket) : null,
      startedAt: ticket ? ticket.openedAt : null,
      cancelAvailable: ticket !== null && ticket.state !== 'committing' && ticket.state !== 'committed',
      // Cheap durable fences only. The mutation revalidates all of them, including a
      // pending native Send/Stop, at operation time.
      startAvailable: mode.blocked === null && ticket === null,
      error: ticket?.error ? ticket.error.slice(0, 240) : null
    }
  };
}

export function createInProcessNightBuildChatOwnerControlV1Source(
  userData: string,
  salt: string
): NightBuildChatOwnerControlV1DataSource {
  return {
    async state(conversation) {
      const resolved = await currentConversation(userData, salt, conversation);
      const state = await projectOwnerState(conversation, resolved);
      await assertUnchanged(userData, salt, conversation, resolved);
      return state;
    },

    async setAutoCompaction(conversation, enabled) {
      const resolved = await currentConversation(userData, salt, conversation);
      // Same fences as the browser sheet: a worker chat never changes the app-wide switch,
      // and a blocked chat may only turn it off.
      if (goalWorkerChat(resolved.conversationId)) throw new Error('worker_compaction_disabled');
      if (enabled && isChatBlocked(resolved.conversationId)) throw new Error('chat_blocked');
      await assertUnchanged(userData, salt, conversation, resolved);
      const cancelledAutomatic = await setAutomaticCompactionNow(enabled);
      await assertUnchanged(userData, salt, conversation, resolved);
      return { ...(await projectOwnerState(conversation, resolved)), cancelledAutomatic };
    },

    async setMode(conversation, mode) {
      const resolved = await currentConversation(userData, salt, conversation);
      await assertUnchanged(userData, salt, conversation, resolved);
      await setSessionAutomation(resolved.sessionId, mode);
      await assertUnchanged(userData, salt, conversation, resolved);
      return projectOwnerState(conversation, resolved);
    },

    async compact(conversation) {
      const resolved = await currentConversation(userData, salt, conversation);
      await assertUnchanged(userData, salt, conversation, resolved);
      await compactSession(resolved.sessionId);
      await assertUnchanged(userData, salt, conversation, resolved);
      return projectOwnerState(conversation, resolved);
    },

    async cancelCompaction(conversation) {
      const resolved = await currentConversation(userData, salt, conversation);
      await assertUnchanged(userData, salt, conversation, resolved);
      const cancelled = await cancelSessionCompactionNow(resolved.sessionId);
      await assertUnchanged(userData, salt, conversation, resolved);
      return { ...(await projectOwnerState(conversation, resolved)), cancelled };
    }
  };
}
