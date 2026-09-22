import type { AgentState, TurnOutcome } from './session.js';
import type { GoalMode } from './types.js';

/** Read-only local contract consumed by Night Build. This is not the browser/MCP protocol. */
export const NIGHT_BUILD_BRIDGE_V2_PROTOCOL = 2 as const;
export const NIGHT_BUILD_BRIDGE_V2_DISCOVERY_FILE = 'night-build-bridge-v2.json';

export const NIGHT_BUILD_BRIDGE_V2_CAPABILITIES = [
  'status',
  'sessions',
  'activity',
  'goal',
  'agents',
  'context',
  'compaction'
] as const;
export type NightBuildBridgeV2Capability = (typeof NIGHT_BUILD_BRIDGE_V2_CAPABILITIES)[number];
export type NightBuildBridgeObservationMode = 'in-process' | 'durable-sidecar';

/** Private 0600 discovery material. `startedAt` identifies this bridge generation. */
export interface NightBuildBridgeV2Discovery {
  protocolVersion: typeof NIGHT_BUILD_BRIDGE_V2_PROTOCOL;
  appVersion: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  startedAt: number;
}

export interface NightBuildBridgeV2DraftCounts {
  sending: number;
  answering: number;
  ready: number;
  noReply: number;
  failed: number;
  retryableFailed: number;
}

export interface NightBuildBridgeV2Status {
  protocolVersion: typeof NIGHT_BUILD_BRIDGE_V2_PROTOCOL;
  appVersion: string;
  observedAt: number;
  capabilities: NightBuildBridgeV2Capability[];
  bridge: {
    observationMode: NightBuildBridgeObservationMode;
    /** Exact bridge generation; equals discovery.startedAt. */
    startedAt: number;
  };
  controller: {
    running: true;
    /** Live CoS process start, never the sidecar/server generation. */
    startedAt: number;
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
    mode: GoalMode;
    observedSessionCount: number;
    objectivePresent: number;
    armed: number;
    draftsObserved: boolean;
    drafts: NightBuildBridgeV2DraftCounts | null;
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
