/**
 * Diagnostic-only equality evidence between a browser stream request id and a recent inbound
 * MCP `x-request-id`.
 *
 * The browser observer publishes one SHA-256 digest per observed request-id candidate, with
 * the exact JSON property path it came from. MCP ingress records the digest of each normalized
 * inbound request id here; the bridge compares digests and reports only a structural
 * `inbound_match` result plus the matching property path. A raw id never enters this module
 * beyond the moment its digest is taken, and the digest is never written to a log, a session,
 * the diagnostics snapshot or disk.
 *
 * Bounds and meaning:
 *   · exact digest equality only — no fuzzy matching, no ordering, no conversation guessing
 *   · process-local and temporal: entries expire after `TTL`, and the registry holds at most
 *     `MAX_ENTRIES` most recently seen ids, pruned on insert and read
 *   · the registry is read only by the bridge diagnostic comparison; it feeds no correlation,
 *     no request ownership and no recovery decision
 */

import { createHash } from 'node:crypto';

/** Five minutes is the whole useful window: a match older than that cannot belong to live work. */
export const REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS = 5 * 60_000;

/** Bounded process-local registry; enough for a busy turn, never an unbounded id log. */
export const REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES = 64;

const REQUEST_ORIGIN_DIGEST = /^[0-9a-f]{64}$/;

/** digest -> inbound time. Map insertion order is refresh order, which is also prune order. */
const recentInbound = new Map<string, number>();

/** The same SHA-256 the browser observer computes: UTF-8 bytes in, lowercase hex out. */
export function requestOriginDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Records one valid normalized inbound request id.
 *
 * Called once per accepted MCP request that carried a valid `x-request-id`; a hash of a
 * bounded short string costs microseconds and touches no I/O.
 */
export function rememberInboundRequestOrigin(value: string, now = Date.now()): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return;
  const digest = requestOriginDigest(value);
  recentInbound.delete(digest);
  recentInbound.set(digest, now);
  pruneRequestOrigins(now);
  while (recentInbound.size > REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES) {
    const oldest = recentInbound.keys().next().value;
    if (oldest === undefined) break;
    recentInbound.delete(oldest);
  }
}

/**
 * Exact-digest lookup. Returns the entry's age in milliseconds, or null for an expired,
 * unknown or malformed digest. Never returns the digest or any id.
 */
export function matchInboundRequestOrigin(digest: string, now = Date.now()): number | null {
  if (typeof digest !== 'string' || !REQUEST_ORIGIN_DIGEST.test(digest)) return null;
  pruneRequestOrigins(now);
  const at = recentInbound.get(digest);
  if (at === undefined) return null;
  return Math.max(0, now - at);
}

function pruneRequestOrigins(now: number): void {
  for (const [digest, at] of recentInbound) {
    if (now - at < REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS) break;
    recentInbound.delete(digest);
  }
}

/** Current retained size after pruning; test/diagnostic inspection only. */
export function requestOriginDiagnosticSize(now = Date.now()): number {
  pruneRequestOrigins(now);
  return recentInbound.size;
}

/** Test seam. Product code never clears the registry: entries expire on their own. */
export function resetRequestOriginDiagnostics(): void {
  recentInbound.clear();
}
