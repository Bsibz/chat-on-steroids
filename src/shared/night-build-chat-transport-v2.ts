/**
 * Narrow owner-local contract for Night Build's native ordinary-ChatGPT write lane.
 *
 * This is intentionally separate from both the read-only Chat Transport v1 and
 * the read-only Night Build controller observation bridge. It exposes only the
 * typed message/Stop capabilities Night Build needs; no browser, MCP, provider,
 * cookie, raw session id or raw ChatGPT conversation id crosses this boundary.
 */
export const NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL = 2 as const;
export const NIGHT_BUILD_CHAT_TRANSPORT_V2_DISCOVERY_FILE = 'night-build-chat-transport-v2.json';
export const NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL_HEADER = 'x-night-build-chat-protocol';
export const NIGHT_BUILD_CHAT_TRANSPORT_V2_CAPABILITIES = ['read', 'send', 'stop'] as const;

export interface NightBuildChatTransportV2Discovery {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL;
  appVersion: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
  capabilities: typeof NIGHT_BUILD_CHAT_TRANSPORT_V2_CAPABILITIES;
}

export type NightBuildChatSendStateV2 =
  | 'queued'
  | 'claimed'
  | 'nativeAcceptanceProved'
  | 'unknown'
  | 'failed';

export interface NightBuildChatSendReceiptV2 {
  /** Generation-scoped opaque identities; never raw recorder/provider ids. */
  userMessage: string;
  turn: string;
  turnOrigin: number;
}

export interface NightBuildChatSendIntentV2 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL;
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

export interface NightBuildChatSendCreateV2 {
  id: string;
  conversation: string;
  text: string;
}

export interface NightBuildChatStopCreateV2 {
  id: string;
  sendId: string;
  conversation: string;
  turn: string;
  userMessage: string;
}

export type NightBuildChatStopStateV2 = 'queued' | 'claimed' | 'stopped' | 'completed' | 'unknown' | 'failed';

export interface NightBuildChatStopIntentV2 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_TRANSPORT_V2_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  id: string;
  sendId: string;
  conversation: string;
  state: NightBuildChatStopStateV2;
  error: 'turn_changed' | 'stop_unavailable' | 'stop_unknown' | null;
}
