import type { NightBuildChatConversationV1 } from '../shared/night-build-chat-transport-v1.js';
import type { SessionSummary } from '../shared/session.js';
import {
  nightBuildChatConversationHandle,
  type NightBuildChatResolvedConversation
} from './night-build-chat-transport-source.js';
import { indexedSessions } from './session/store.js';

/**
 * In-process Native Chat identity projection.
 *
 * The session store already maintains a process-lifetime authoritative metadata
 * index plus live overlays for open sessions.  Reuse that index for repeated
 * Night Build reads instead of reparsing every retained meta.json on each HTTP
 * poll.  Sidecar v1 keeps the independent file-only source unchanged.
 *
 * This resolver grants no mutation authority.  Every caller that can mutate a
 * chat still rechecks the exact session + current conversation at its existing
 * mutation fence.  Ambiguous conversation ownership is omitted, matching the
 * file-backed transport source.
 */
export interface NightBuildChatInProcessResolver {
  list(): Promise<NightBuildChatConversationV1[]>;
  resolve(handle: string): Promise<NightBuildChatResolvedConversation | null>;
  handleForIdentity(sessionId: string, conversationId: string): Promise<string | null>;
}

function eligible(summary: SessionSummary): summary is SessionSummary & { conversationId: string } {
  if (!summary.conversationId) return false;
  if (summary.origin?.kind === 'worker' || summary.origin?.kind === 'helper') return false;
  if (summary.chatIds.length === 0 || summary.chatIds.at(-1) !== summary.conversationId) return false;
  // The file-backed source hides pre-canonical-projection sessions rather than
  // guessing identity. Mirror that admission rule from the validated store view.
  if (summary.timelineTurns === undefined || summary.requestTurns === undefined || summary.nativeQuestion === undefined) {
    return false;
  }
  return true;
}

async function uniqueCurrentSessions(): Promise<Array<SessionSummary & { conversationId: string }>> {
  const candidates = (await indexedSessions()).filter(eligible);
  const ownership = new Map<string, number>();
  for (const session of candidates) {
    ownership.set(session.conversationId, (ownership.get(session.conversationId) ?? 0) + 1);
  }
  return candidates.filter((session) => ownership.get(session.conversationId) === 1);
}

function publicConversation(
  salt: string,
  session: SessionSummary & { conversationId: string }
): NightBuildChatConversationV1 {
  return {
    handle: nightBuildChatConversationHandle(salt, session.id, session.conversationId),
    title: session.title,
    updatedAt: session.updatedAt
  };
}

export function createInProcessNightBuildChatResolver(salt: string): NightBuildChatInProcessResolver {
  if (!salt) throw new Error('chat_transport_salt_missing');
  return {
    async list() {
      return (await uniqueCurrentSessions())
        .map((session) => publicConversation(salt, session))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 200);
    },

    async resolve(handle) {
      const matches = (await uniqueCurrentSessions()).filter((session) =>
        nightBuildChatConversationHandle(salt, session.id, session.conversationId) === handle
      );
      if (matches.length !== 1) return null;
      const session = matches[0]!;
      return {
        handle,
        sessionId: session.id,
        conversationId: session.conversationId,
        title: session.title,
        updatedAt: session.updatedAt
      };
    },

    async handleForIdentity(sessionId, conversationId) {
      const matches = (await uniqueCurrentSessions()).filter((session) =>
        session.id === sessionId && session.conversationId === conversationId
      );
      return matches.length === 1
        ? nightBuildChatConversationHandle(salt, sessionId, conversationId)
        : null;
    }
  };
}
