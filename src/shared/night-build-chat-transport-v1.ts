/** Separate read-only contract for Night Build's native ordinary-ChatGPT surface. */
export const NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL = 1 as const;
export const NIGHT_BUILD_CHAT_TRANSPORT_V1_DISCOVERY_FILE = 'night-build-chat-transport-v1.json';
export const NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL_HEADER = 'x-night-build-chat-protocol';

export interface NightBuildChatTransportV1Discovery {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL;
  appVersion: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
}

export type NightBuildChatTurnOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'stalled'
  | 'unknown';

export interface NightBuildChatConversationV1 {
  handle: string;
  title: string;
  updatedAt: number;
}

export interface NightBuildChatConversationListV1 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  conversations: NightBuildChatConversationV1[];
}

export interface NightBuildChatTranscriptItemV1 {
  itemId: string;
  role: 'user' | 'assistant';
  originSeq: number;
  revisionSeq: number;
  authoredAt: number;
  turnOrigin: number | null;
  text: string;
  truncated: boolean;
  chars: number;
  state?: 'streaming' | 'final';
  finalContentSeq?: number;
}

export type NightBuildChatCurrentTurnV1 =
  | { state: 'idle' }
  | { state: 'generating'; turnOrigin: number | null }
  | { state: 'terminal'; outcome: NightBuildChatTurnOutcome; endedAt: number | null };

export interface NightBuildChatTranscriptV1 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V1_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  conversation: { handle: string; title: string; updatedAt: number };
  projection: {
    current: boolean;
    identitySource: 'metadata' | 'rebuilt';
    lowerBoundOrigin: number;
    observedHighWaterSeq: number;
    metadataHighWaterSeq: number;
  };
  page: {
    mode: 'recent' | 'backfill' | 'incremental';
    hasEarlier: boolean;
    hasMore: boolean;
    earliestOrigin: number | null;
    latestRevision: number;
  };
  currentTurn: NightBuildChatCurrentTurnV1;
  items: NightBuildChatTranscriptItemV1[];
}
