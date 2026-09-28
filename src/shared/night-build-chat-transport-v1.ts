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
  attachments?: NightBuildChatAttachmentV1[];
  state?: 'streaming' | 'final';
  finalContentSeq?: number;
}

export interface NightBuildChatAttachmentV1 {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  preview?: string;
}

export type NightBuildChatActivityKindV1 =
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'read'
  | 'search'
  | 'browse'
  | 'run'
  | 'process'
  | 'screen'
  | 'input'
  | 'clipboard'
  | 'session'
  | 'agent'
  | 'other';

export type NightBuildChatActivityToneV1 = 'neutral' | 'good' | 'bad' | 'warn';

export type NightBuildChatActivityPhaseV1 =
  | 'started'
  | 'completed'
  | 'finished'
  | 'failed'
  | 'refused'
  | 'internal_error'
  | 'unknown';

/** Compact public tool activity. Never carries args, results, or raw recorder ids. */
export interface NightBuildChatActivityItemV1 {
  activityId: string;
  originSeq: number;
  revisionSeq: number;
  turnOrigin: number;
  time: number;
  tool: string;
  kind: NightBuildChatActivityKindV1;
  tone: NightBuildChatActivityToneV1;
  title: string;
  detail?: string;
  metric?: string;
  phase: NightBuildChatActivityPhaseV1;
  exitCode?: number;
  durationMs?: number;
  changedFiles?: number;
  /** Sanitized changed paths only; raw tool args/results never cross this contract. */
  changedPaths?: string[];
}

export type NightBuildChatCurrentTurnV1 =
  | { state: 'idle' }
  | { state: 'generating'; turnOrigin: number | null }
  | { state: 'terminal'; outcome: NightBuildChatTurnOutcome; endedAt: number | null; turnOrigin?: number | null };

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
  /** Present means this producer supports activity. Empty means none is currently visible. */
  activity: NightBuildChatActivityItemV1[];
}
