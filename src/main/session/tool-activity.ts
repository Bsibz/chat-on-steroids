import { createHash } from 'node:crypto';

import type { ActivitySummary, ToolOutcome } from '../../shared/session.js';
import { toolCallSummary } from '../../shared/session.js';
import type {
  NightBuildChatActivityItemV1,
  NightBuildChatActivityKindV1,
  NightBuildChatActivityPhaseV1,
  NightBuildChatActivityToneV1
} from '../../shared/night-build-chat-transport-v1.js';
import { redactCredentialText } from '../redaction.js';

const KINDS = new Set<NightBuildChatActivityKindV1>([
  'edit', 'create', 'delete', 'move', 'read', 'search', 'browse', 'run', 'process',
  'screen', 'input', 'clipboard', 'session', 'agent', 'other'
]);
const TONES = new Set<NightBuildChatActivityToneV1>(['neutral', 'good', 'bad', 'warn']);
const OUTCOMES = new Set<ToolOutcome>([
  'ok', 'process_exit_nonzero', 'tool_rejected', 'tool_execution_error', 'tool_internal_error'
]);

export interface NightBuildActivityCandidate {
  authority: 'journal' | 'canonical';
  seq: number;
  origin: number;
  time: number;
  turnId?: string;
  callId: string;
  requestId: string | null;
  conversationId: string | null;
  tool: string;
  outcome: ToolOutcome;
  durationMs?: number;
  summary: ActivitySummary;
  process?: { completedAt?: number; exitCode?: number | null; durationMs?: number };
  changedFiles?: number;
  changedPaths?: string[];
}

export interface NightBuildActivityTurnLookup {
  conversationId: string;
  lowerBoundOrigin: number;
  /** Exact timeline origin for a turn id, after response-turn aliasing. Null hides the call. */
  turnOrigin: (turnId: string) => number | null;
  /**
   * Durable request owner. Undefined means the request was not held.
   * Null means it was held and is not this conversation.
   */
  requestTurn: (requestId: string) => { turnId: string; conversationId: string } | null | undefined;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/** Parse one durable tool_call into a fold candidate. Incomplete or disallowed calls are hidden. */
export function parseNightBuildActivityCandidate(
  event: Record<string, unknown>,
  authority: 'journal' | 'canonical'
): NightBuildActivityCandidate | null {
  if (event['kind'] !== 'tool_call' || event['source'] !== 'mcp') return null;
  const seq = safeInt(event['seq']);
  const time = safeInt(event['time']);
  if (seq === null || seq <= 0 || time === null || time <= 0) return null;
  const originValue = event['origin'];
  const origin = originValue === undefined ? seq : safeInt(originValue);
  if (origin === null || origin <= 0 || origin > seq) return null;
  const turnId = event['turnId'];
  if (turnId !== undefined && (typeof turnId !== 'string' || !turnId)) return null;
  const call = object(event['call']);
  if (!call) return null;
  if (call['nested'] === true) return null;
  if (call['attribution'] !== 'request_id' || call['attributionMethod'] !== 'request_id') return null;
  if (typeof call['callId'] !== 'string' || !call['callId']) return null;
  if (typeof call['tool'] !== 'string' || !call['tool'] || call['tool'].length > 64) return null;
  if (typeof call['outcome'] !== 'string' || !OUTCOMES.has(call['outcome'] as ToolOutcome)) return null;
  const requestId = call['requestId'];
  const conversationId = call['conversationId'];
  if (requestId !== null && typeof requestId !== 'string') return null;
  if (conversationId !== null && typeof conversationId !== 'string') return null;
  const summary = object(call['summary']);
  if (!summary || typeof summary['title'] !== 'string' || !summary['title']) return null;
  if (typeof summary['kind'] !== 'string' || !KINDS.has(summary['kind'] as NightBuildChatActivityKindV1)) return null;
  if (typeof summary['tone'] !== 'string' || !TONES.has(summary['tone'] as NightBuildChatActivityToneV1)) return null;
  const detail = optionalText(summary['detail']);
  const metric = optionalText(summary['metric']);
  if (detail === null || metric === null) return null;
  const durationMs = call['durationMs'];
  if (durationMs !== undefined && (safeInt(durationMs) === null || (durationMs as number) < 0)) return null;
  let process: NightBuildActivityCandidate['process'];
  if (call['process'] !== undefined) {
    const row = object(call['process']);
    if (!row) return null;
    const completedAt = row['completedAt'];
    const exitCode = row['exitCode'];
    const processDuration = row['durationMs'];
    if (completedAt !== undefined && safeInt(completedAt) === null) return null;
    if (exitCode !== undefined && exitCode !== null && safeInt(exitCode) === null) return null;
    if (processDuration !== undefined && (safeInt(processDuration) === null || (processDuration as number) < 0)) return null;
    process = {
      ...(completedAt === undefined ? {} : { completedAt: completedAt as number }),
      ...(exitCode === undefined ? {} : { exitCode: exitCode as number | null }),
      ...(processDuration === undefined ? {} : { durationMs: processDuration as number })
    };
  }
  let changedFiles: number | undefined;
  let changedPaths: string[] | undefined;
  if (call['changes'] !== undefined) {
    if (!Array.isArray(call['changes'])) return null;
    if (call['changes'].length > 100_000) return null;
    changedFiles = call['changes'].length;
    const paths: string[] = [];
    for (const value of call['changes']) {
      const change = object(value);
      if (!change || typeof change['path'] !== 'string' || !change['path'] || change['path'].length > 4096) return null;
      if (paths.length < 8 && !paths.includes(change['path'])) paths.push(change['path']);
    }
    if (paths.length) changedPaths = paths;
  }
  return {
    authority,
    seq,
    origin,
    time,
    ...(typeof turnId === 'string' ? { turnId } : {}),
    callId: call['callId'],
    requestId: typeof requestId === 'string' ? requestId : null,
    conversationId: typeof conversationId === 'string' ? conversationId : null,
    tool: call['tool'],
    outcome: call['outcome'] as ToolOutcome,
    ...(durationMs === undefined ? {} : { durationMs: durationMs as number }),
    summary: {
      title: summary['title'],
      kind: summary['kind'] as ActivitySummary['kind'],
      tone: summary['tone'] as ActivitySummary['tone'],
      ...(detail ? { detail } : {}),
      ...(metric ? { metric } : {})
    },
    ...(process ? { process } : {}),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(changedPaths === undefined ? {} : { changedPaths })
  };
}

function opaque(salt: string, domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(salt).update('\0').update(value).digest('base64url');
}

function harden(text: string, home: string, max: number): string {
  let value = redactCredentialText(text);
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  value = value.replace(/\b(?:access_token|refresh_token|id_token|api[_-]?key|cookie)\s*[=:]\s*\S+/gi, '[redacted]');
  if (home.length > 1 && home !== '/') value = value.split(home).join('~');
  value = value.trim();
  if (value.length > max) value = value.slice(0, max).trim();
  return value;
}

function owningTurn(candidate: NightBuildActivityCandidate, lookup: NightBuildActivityTurnLookup): number | null {
  if (candidate.conversationId !== lookup.conversationId) return null;
  const requestOwner = candidate.requestId ? lookup.requestTurn(candidate.requestId) : undefined;
  if (candidate.requestId && requestOwner !== undefined) {
    if (!requestOwner || requestOwner.conversationId !== lookup.conversationId) return null;
  }
  if (candidate.turnId) {
    const origin = lookup.turnOrigin(candidate.turnId);
    if (origin === null) return null;
    if (requestOwner && lookup.turnOrigin(requestOwner.turnId) !== origin) return null;
    return origin;
  }
  if (!requestOwner) return null;
  return lookup.turnOrigin(requestOwner.turnId);
}

function phaseFor(candidate: NightBuildActivityCandidate): NightBuildChatActivityPhaseV1 {
  const running = candidate.process !== undefined && candidate.process.completedAt === undefined;
  if (running && candidate.outcome === 'ok') return 'started';
  switch (candidate.outcome) {
    case 'ok':
      return candidate.process?.completedAt !== undefined ? 'finished' : 'completed';
    case 'process_exit_nonzero':
    case 'tool_execution_error':
      return 'failed';
    case 'tool_rejected':
      return 'refused';
    case 'tool_internal_error':
      return 'internal_error';
    default:
      return 'unknown';
  }
}

interface Folded extends NightBuildActivityCandidate {
  originSeq: number;
  revisionSeq: number;
}

function prefer(candidate: NightBuildActivityCandidate, current: Folded): boolean {
  if (candidate.seq !== current.revisionSeq) return candidate.seq > current.revisionSeq;
  return candidate.authority === 'canonical' && current.authority === 'journal';
}

/**
 * Fold journal launches and canonical process revisions for one conversation.
 * The first origin is kept. The newest canonical body wins ties with a journal copy.
 */
export function projectNightBuildToolActivity(
  candidates: readonly NightBuildActivityCandidate[],
  lookup: NightBuildActivityTurnLookup,
  salt: string,
  homeDirectory: string
): NightBuildChatActivityItemV1[] {
  const folded = new Map<string, Folded>();
  for (const candidate of candidates) {
    const current = folded.get(candidate.callId);
    if (!current) {
      folded.set(candidate.callId, { ...candidate, originSeq: candidate.origin, revisionSeq: candidate.seq });
      continue;
    }
    const originSeq = Math.min(current.originSeq, candidate.origin);
    if (!prefer(candidate, current)) {
      current.originSeq = originSeq;
      continue;
    }
    folded.set(candidate.callId, { ...candidate, originSeq, revisionSeq: candidate.seq });
  }
  const projected: NightBuildChatActivityItemV1[] = [];
  for (const row of folded.values()) {
    const turnOrigin = owningTurn(row, lookup);
    if (turnOrigin === null || turnOrigin < Math.max(1, lookup.lowerBoundOrigin)) continue;
    if (row.originSeq < lookup.lowerBoundOrigin || row.revisionSeq < row.originSeq) continue;
    const summary = toolCallSummary({ tool: row.tool, summary: row.summary });
    const title = harden(summary.title, homeDirectory, 200);
    const tool = harden(row.tool, homeDirectory, 64);
    if (!title || !tool) continue;
    const detail = summary.detail ? harden(summary.detail, homeDirectory, 200) : '';
    const metric = summary.metric ? harden(summary.metric, homeDirectory, 40) : '';
    const phase = phaseFor(row);
    const exitCode = row.process?.exitCode;
    const durationMs = row.process?.completedAt !== undefined && row.process.durationMs !== undefined
      ? row.process.durationMs
      : row.durationMs;
    const item: NightBuildChatActivityItemV1 = {
      activityId: opaque(salt, 'activity', row.callId),
      originSeq: row.originSeq,
      revisionSeq: row.revisionSeq,
      turnOrigin,
      time: row.time,
      tool,
      kind: summary.kind,
      tone: summary.tone,
      title,
      phase
    };
    if (detail) item.detail = detail;
    if (metric) item.metric = metric;
    if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode >= -4096 && exitCode <= 4096) {
      item.exitCode = exitCode;
    }
    if (durationMs !== undefined && durationMs >= 0) item.durationMs = durationMs;
    if (row.changedFiles !== undefined && row.changedFiles > 0 && row.changedFiles <= 100_000) {
      item.changedFiles = row.changedFiles;
    }
    if (row.changedPaths?.length) {
      const paths = row.changedPaths
        .map((path) => harden(path, homeDirectory, 160))
        .filter((path, index, all) => Boolean(path) && all.indexOf(path) === index)
        .slice(0, 8);
      if (paths.length) item.changedPaths = paths;
    }
    projected.push(item);
  }
  return projected.sort((a, b) => a.originSeq - b.originSeq || a.revisionSeq - b.revisionSeq || (a.activityId < b.activityId ? -1 : 1));
}
