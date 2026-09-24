import type { ChatModelCatalog } from './chat-models.js';
import type { InputAttachment } from './input.js';
import type { AgentPlan } from './agent-plan.js';
import type { ReasoningEffort } from './session.js';
import type { NightBuildChatSendReceiptV2, NightBuildChatSendStateV2 } from './night-build-chat-transport-v2.js';

/**
 * Owner-local optional powers layered beside Native Chat Transport v2.
 *
 * v2 remains byte-for-byte compatible for installed Night Build builds. v3
 * carries only features whose contract is richer than text Send/Stop.
 */
export const NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL = 3 as const;
export const NIGHT_BUILD_CHAT_CONTROL_V3_DISCOVERY_FILE = 'night-build-chat-control-v3.json';
export const NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL_HEADER = 'x-night-build-chat-protocol';
export const NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES = [
  'state',
  'model-catalog',
  'attachment-stage',
  'configured-send',
  'fresh-send',
  'cancel-send'
] as const;

export interface NightBuildChatControlV3Discovery {
  protocolVersion: typeof NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL;
  appVersion: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
  capabilities: typeof NIGHT_BUILD_CHAT_CONTROL_V3_CAPABILITIES;
}

export interface NightBuildChatControlStateV3 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  conversation: string;
  selectedModel: {
    model: string;
    reasoningEffort: ReasoningEffort | null;
    observedAt: number;
  } | null;
  /** Exact recorder-owned open-turn timing, keyed only by its public chronology origin. */
  activeTurn: {
    turnOrigin: number;
    startedAt: number;
  } | null;
  /** Bounded owner-facing plan already stored by update_plan for this session. */
  plan: AgentPlan | null;
  modelCatalog: ChatModelCatalog;
  context: {
    /** Recorder estimate, never ChatGPT's private provider counter. */
    estimatedTokens: number;
    configuredLimit: number;
    configuredWarning: number;
    autoCompaction: boolean;
    autoCompactionAt: number | null;
  };
}

export interface NightBuildChatConfiguredSendCreateV3 {
  id: string;
  conversation: string;
  text: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  attachments: InputAttachment[];
}

export interface NightBuildChatConfiguredSendIntentV3 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  id: string;
  conversation: string;
  state: NightBuildChatSendStateV2;
  createdAt: number;
  claimedAt: number | null;
  receipt: NightBuildChatSendReceiptV2 | null;
  error: 'conversation_unavailable' | 'conversation_busy' | 'pre_send_failed' | 'acceptance_unknown' | null;
}

/**
 * Creates the first authored message of a brand-new ChatGPT conversation.
 *
 * The selected source is an opaque existing Night Build handle. CoS uses that
 * source only as browser-placement truth (including same-Project inheritance);
 * raw provider conversation/Project ids never cross this contract.
 */
export interface NightBuildChatFreshSendCreateV3 {
  id: string;
  sourceConversation: string;
  text: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  attachments: InputAttachment[];
}

export interface NightBuildChatFreshSendIntentV3 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  id: string;
  destinationConversation: string | null;
  state: NightBuildChatSendStateV2;
  createdAt: number;
  claimedAt: number | null;
  receipt: NightBuildChatSendReceiptV2 | null;
  error: 'pre_send_failed' | 'acceptance_unknown' | null;
}

export interface NightBuildChatAttachmentStageV3 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_CONTROL_V3_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  attachment: InputAttachment;
}
