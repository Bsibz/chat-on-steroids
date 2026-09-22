import type { AgentState, TurnOutcome } from './session.js';
import type { ConnectionState, GoalMode } from './types.js';

/** Read-only local contract consumed by Night Build. This is not the browser bridge protocol. */
export const NIGHT_BUILD_BRIDGE_PROTOCOL = 1 as const;
export const NIGHT_BUILD_BRIDGE_DISCOVERY_FILE = 'night-build-bridge-v1.json';

export type NightBuildCapability =
  | 'status'
  | 'sessions'
  | 'activity'
  | 'goal'
  | 'agents'
  | 'browser-automation'
  | 'context';

/**
 * Local private discovery material. The bearer is intentionally present only in this 0600 file,
 * never in bridge responses, logs or support projections.
 */
export interface NightBuildBridgeDiscovery {
  protocolVersion: typeof NIGHT_BUILD_BRIDGE_PROTOCOL;
  appVersion: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
}

export interface NightBuildBridgeStatus {
  protocolVersion: typeof NIGHT_BUILD_BRIDGE_PROTOCOL;
  appVersion: string;
  observedAt: number;
  capabilities: NightBuildCapability[];
  controller: {
    running: true;
    startedAt: number;
  };
  connection: {
    state: ConnectionState;
    handshakeAt: number | null;
    lastRequestAt: number | null;
    lastToolCallAt: number | null;
    surfaceCount: number;
    availableSurfaceCount: number;
  };
  browserAutomation: {
    running: boolean;
    paired: boolean;
    present: boolean;
    lastSeenAt: number | null;
  };
  features: {
    recording: boolean;
    multiAgent: boolean;
    goal: boolean;
    compactionAuto: boolean;
    advisoryTokens: number;
    limitTokens: number;
    autoCompactionTokens: number;
  };
  sessions: {
    listedTotal: number;
    observed: number;
    activeTurns: number;
    lastUpdatedAt: number | null;
    context: {
      maxEstimatedContextTokens: number;
      maxEstimatedSessionTokens: number;
      sessionsAtOrAboveAdvisory: number;
      sessionsAtOrAboveAutoCompaction: number;
    };
    activity: {
      events: number;
      userMessages: number;
      toolCalls: number;
      errors: number;
      toolRejected: number;
      processExitNonzero: number;
      lastToolCallAt: number | null;
      lastAssistantFinalAt: number | null;
      lastTurnEndAt: number | null;
    };
    compaction: {
      sessionsWithHandoff: number;
      sessionsWithCommittedResume: number;
      lastHandoffAt: number | null;
    };
    outcomes: Record<TurnOutcome | 'unreported', number>;
  };
  goal: {
    enabled: boolean;
    configuredMode: GoalMode;
    observedSessionCount: number;
    objectivePresent: number;
    armed: number;
    drafts: {
      sending: number;
      answering: number;
      ready: number;
      noReply: number;
      failed: number;
      retryableFailed: number;
    };
  };
  workers: {
    enabled: boolean;
    running: boolean;
    retainedHistory: boolean;
    totalAgents: number;
    workerCount: number;
    activeWorkers: number;
    sleepingWorkers: number;
    terminalWorkers: number;
    stateCounts: Record<AgentState, number>;
    maxEstimatedContextTokens: number;
  };
}
