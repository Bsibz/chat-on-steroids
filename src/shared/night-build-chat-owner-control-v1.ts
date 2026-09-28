/**
 * Owner control for Compact & Resume, automatic compaction and Goal/Loop.
 *
 * A separate versioned loopback generation beside the frozen Native Chat Control v3
 * (`night-build-chat-control-v3`). v3's capability set and discovery file stay byte-for-byte
 * compatible for installed Night Build builds; owner controls do not expand v3 because an
 * already-installed client rejects an unknown capability generation outright.
 *
 * CoS remains the only owner. Every request identifies the conversation through the existing
 * opaque Night Build handle, and every mutation is routed through the same bridge/Goal/
 * continuation owners the app's own controls use. Nothing here maintains a parallel switch,
 * objective or continuation ledger.
 *
 * Truth boundaries:
 *  · `triggerTokens` is the local recorder trigger in locally estimated units. It is never
 *    ChatGPT's provider context occupancy, and the state deliberately carries no estimate that
 *    could be read as one.
 *  · `autoCompaction.configured` is the app-wide saved switch. `effective` is that switch AND
 *    this exact chat's model/role eligibility (the exact-Pro exemption), before any of the
 *    live level/threshold/work gates that decide whether a ticket is actually filed.
 *  · `compaction.cancelAvailable` is false once the durable transaction has crossed its abort
 *    boundary; a cancel response for that case reports `cancelled: false` rather than pretending
 *    the move was stopped.
 */
export const NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL = 1 as const;
export const NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_DISCOVERY_FILE = 'night-build-chat-owner-control-v1.json';
export const NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL_HEADER = 'x-night-build-chat-owner-control-protocol';
export const NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES = [
  'owner-state',
  'auto-compaction-set',
  'conversation-mode-set',
  'compact-resume',
  'compact-cancel'
] as const;

export interface NightBuildChatOwnerControlV1Discovery {
  protocolVersion: typeof NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL;
  appVersion: string;
  /** Shared with the stable v2/v3 generation so a stale v3 file cannot prove identity. */
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
  capabilities: typeof NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_CAPABILITIES;
}

/** The effective mode the app would run for this chat; a fenced chat reports `off`. */
export type NightBuildChatOwnerModeV1 = 'off' | 'goal' | 'loop';

/** Why owner mutations that turn work on are refused for this exact chat. */
export type NightBuildChatOwnerFenceV1 = 'worker' | 'blocked' | null;

/** Why automatic compaction is configured on but not effective for this exact chat. */
export type NightBuildChatOwnerAutoExemptionV1 = 'pro' | null;

export type NightBuildChatOwnerCompactionStateV1 =
  | 'none'
  | 'awaiting-summary'
  | 'awaiting-chat'
  | 'claimed'
  | 'committing'
  | 'committed'
  | 'aborted';

export type NightBuildChatOwnerCompactionPhaseV1 = 'asking' | 'writing' | 'opening';

export interface NightBuildChatOwnerStateV1 {
  protocolVersion: typeof NIGHT_BUILD_CHAT_OWNER_CONTROL_V1_PROTOCOL;
  appVersion: string;
  transportStartedAt: number;
  observedAt: number;
  /** Echo of the opaque handle the caller named. */
  conversation: string;
  /**
   * 1. The app-wide saved switch.
   * 2. Whether it is effective for this exact chat, before the live threshold/work gates.
   * 3. The local recorder trigger threshold in locally estimated units.
   */
  autoCompaction: {
    configured: boolean;
    effective: boolean;
    exemption: NightBuildChatOwnerAutoExemptionV1;
    triggerTokens: number;
  };
  /** 4. Exact conversation mode from the existing per-chat Goal/Loop owner. */
  mode: NightBuildChatOwnerModeV1;
  blocked: NightBuildChatOwnerFenceV1;
  /** 5. The exact Compact & Resume transaction, and whether cancel can still change it. */
  compaction: {
    active: boolean;
    state: NightBuildChatOwnerCompactionStateV1;
    automatic: boolean;
    phase: NightBuildChatOwnerCompactionPhaseV1 | null;
    startedAt: number | null;
    cancelAvailable: boolean;
    /**
     * The durable chat fences currently allow starting one. The mutation revalidates
     * every fence — including a pending native Send/Stop — at operation time.
     */
    startAvailable: boolean;
    error: string | null;
  };
}
