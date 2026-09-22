import type { SessionSummary, SwarmState } from '../shared/session.js';
import type { Config } from '../shared/types.js';
import { swarmState } from './agents.js';
import { getConfig } from './config.js';
import { goalObserverFor } from './goal.js';
import { type NightBuildBridgeV2DataSource, type NightBuildBridgeV2FeatureInput, type NightBuildBridgeV2SessionInput } from './night-build-bridge-v2.js';
import { peekSessionPage } from './session/store.js';

const OBSERVED_SESSION_LIMIT = 50;
const OUTCOMES = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'] as const;
const AGENT_STATES = ['invited', 'active', 'detached', 'waking', 'sleeping', 'finished', 'failed'] as const;

function nonnegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value)
    : 0;
}

function timestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function featureInput(config: Config): NightBuildBridgeV2FeatureInput {
  return {
    recording: config.sessions.record,
    multiAgent: config.multiAgent.enabled,
    goal: config.goal.enabled,
    compactionAuto: config.compaction.auto,
    advisoryTokens: config.sessions.advisoryTokens,
    limitTokens: config.sessions.limitTokens,
    autoCompactionTokens: config.compaction.autoTokens
  };
}

function sessionInput(summary: SessionSummary): NightBuildBridgeV2SessionInput {
  return {
    conversationId: summary.conversationId,
    updatedAt: nonnegative(summary.updatedAt),
    events: nonnegative(summary.events),
    userMessages: nonnegative(summary.userMessages),
    toolCalls: nonnegative(summary.toolCalls),
    errors: nonnegative(summary.errors),
    toolRejected: nonnegative(summary.toolRejected),
    processExitNonzero: nonnegative(summary.processExitNonzero),
    contextTokens: nonnegative(summary.contextTokens),
    estimatedTokens: nonnegative(summary.estimatedTokens),
    lastToolCallAt: timestamp(summary.lastToolCallAt),
    lastAssistantFinalAt: timestamp(summary.lastAssistantFinalAt),
    lastTurnEndAt: timestamp(summary.lastTurnEndAt),
    lastHandoffAt: timestamp(summary.lastHandoffAt),
    lastCommittedResumeHandoffId: summary.lastCommittedResumeHandoffId || null,
    lastTurnOutcome: summary.lastTurnOutcome && OUTCOMES.includes(summary.lastTurnOutcome) ? summary.lastTurnOutcome : null,
    activeTurnId: summary.activeTurnId || null
  };
}

export function createInProcessNightBuildBridgeV2Source(
  controllerStartedAt = Math.floor(Date.now() - process.uptime() * 1_000)
): NightBuildBridgeV2DataSource {
  return {
    observationMode: 'in-process',
    controllerStartedAt,
    async snapshot() {
      const config = getConfig();
      const page = await peekSessionPage({ limit: OBSERVED_SESSION_LIMIT });
      const seen = new Set<string>();
      const goalRows = [];
      for (const summary of page.sessions) {
        if (!summary.conversationId || seen.has(summary.conversationId)) continue;
        seen.add(summary.conversationId);
        goalRows.push(goalObserverFor(summary.conversationId));
      }
      const workers: SwarmState = swarmState();
      return {
        features: featureInput(config),
        sessions: { total: page.total, rows: page.sessions.map(sessionInput) },
        goal: { enabled: config.goal.enabled, mode: config.goal.mode, rows: goalRows, draftsObserved: true },
        workers: {
          enabled: workers.enabled,
          running: workers.running,
          retainedHistory: workers.retainedHistory === true,
          rows: workers.agents.flatMap((agent) => {
            if (!AGENT_STATES.includes(agent.state)) return [];
            return [{ role: agent.role, state: agent.state, contextTokens: nonnegative(agent.contextTokens) }];
          })
        }
      };
    }
  };
}
