/**
 * Process-local matching evidence for direct-A ChatGPT conversation SSE observations.
 *
 * Live signed-in ChatGPT proved that a conversation POST's SSE response carries the user
 * message envelope `input_message` with `metadata.request_id` and `author.role === 'user'`,
 * under the response's root `conversation_id`. The same scalar id arrives on the Core MCP
 * request as the normalized `x-request-id` (see `mcp/inbound.ts`). This module owns only the
 * *equality* between those two process-local facts; it grants no ownership by itself.
 *
 * Ownership is recorded elsewhere: the bridge's existing `/correlations` handshake still
 * creates/reuses the conversation session, writes the exact request-id join through the
 * recorder and reads the durable owner back. A `paired` verdict makes a direct-A observation
 * eligible only for the bridge's short-lived prepared commit; the extension must revalidate
 * the same Chrome document/route before a second one-shot request may enter that evidence batch.
 * That browser read is the authorization linearization point. A navigation that starts only
 * afterwards does not revoke the historical owner of the already-proved request; the durable
 * correlation registry intentionally survives the page being reloaded or closed.
 *
 * Bounds and meaning:
 *   · exact string equality only — no fuzzy matching, no ordering, no conversation inference,
 *     no "only active request" fallback and no timing that a caller could satisfy by waiting
 *   · two bounded process-local registries (recent inbound MCP ids and pending direct-A
 *     candidates); each holds at most `REQUEST_ORIGIN_MAX_ENTRIES` entries and expires after
 *     `REQUEST_ORIGIN_TTL_MS`, pruned on every insert and read
 *   · a candidate is permanently bound to the first document tuple that offered it: the same
 *     id offered by another document, navigation epoch or conversation is a conflict, not a
 *     retry
 *   · nothing here is durable and nothing survives a process restart; an unpaired candidate or
 *     inbound id simply expires. Once the recorder has stored a proof, `correlation.ts` owns
 *     it permanently under its existing first-proof-wins rule.
 */

/** Five minutes is the whole useful window: older evidence cannot belong to live work. */
export const REQUEST_ORIGIN_TTL_MS = 5 * 60_000;

/** Bounded per side; enough for a busy turn, never an unbounded id log. */
export const REQUEST_ORIGIN_MAX_ENTRIES = 64;

/** The same normalized shape the MCP ingress accepts (`mcp/inbound.ts`). */
const REQUEST_ID = /^[a-z0-9_-]{1,100}$/i;
/** ChatGPT conversation ids are UUIDs; anything else is not route identity. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_ID_MAX = 200;
/** A page clock minute ahead is tolerated; a claim further in the future is malformed. */
const OBSERVED_AT_FUTURE_SKEW_MS = 60_000;

/** The exact browser document that observed one candidate. A body field cannot forge it. */
export interface DirectOriginDocument {
  tab: number;
  documentId: string;
  navigationEpoch: number;
}

export interface DirectOriginOffer {
  requestId: string;
  conversationId: string;
  /** Page observation time in epoch ms, bounded against the process clock below. */
  observedAt: number;
  document: DirectOriginDocument;
}

/** `paired` is the only verdict that lets a direct-A observation enter ownership evidence. */
export type DirectOriginVerdict = 'paired' | 'awaiting_inbound' | 'stale' | 'conflict' | 'malformed';

interface DirectCandidate {
  requestId: string;
  conversationId: string;
  document: DirectOriginDocument;
  observedAt: number;
  /** First-offer time is the TTL anchor; a re-offer never extends the candidate's life. */
  storedAt: number;
}

/** id -> last sighting. Insertion order is refresh order; refresh = delete + set. */
const recentInbound = new Map<string, number>();
/** requestId -> candidate. Insertion order is first-offer order; TTL never refreshes. */
const directCandidates = new Map<string, DirectCandidate>();

function prune(now: number): void {
  for (const [id, at] of recentInbound) {
    if (now - at < REQUEST_ORIGIN_TTL_MS) break;
    recentInbound.delete(id);
  }
  for (const [id, candidate] of directCandidates) {
    if (now - candidate.storedAt < REQUEST_ORIGIN_TTL_MS) break;
    directCandidates.delete(id);
  }
}

function validDocument(document: unknown): document is DirectOriginDocument {
  if (!document || typeof document !== 'object') return false;
  const candidate = document as Partial<DirectOriginDocument>;
  return (
    Number.isSafeInteger(candidate.tab) && (candidate.tab as number) >= 0 &&
    typeof candidate.documentId === 'string' && candidate.documentId.length > 0 &&
    candidate.documentId.length <= DOCUMENT_ID_MAX &&
    Number.isSafeInteger(candidate.navigationEpoch) && (candidate.navigationEpoch as number) >= 0
  );
}

function sameDocument(left: DirectOriginDocument, right: DirectOriginDocument): boolean {
  return left.tab === right.tab && left.documentId === right.documentId &&
    left.navigationEpoch === right.navigationEpoch;
}

/**
 * Records one valid normalized inbound MCP request id.
 *
 * Called once per accepted HTTP request that carried a valid `x-request-id`; a repeated id
 * from the same workflow refreshes its freshness without adding an entry. Inbound order and
 * candidate order are deliberately irrelevant: equality is read whenever either side is
 * inspected, so both observation orders resolve.
 */
export function rememberInboundRequestId(id: string, now = Date.now()): void {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return;
  prune(now);
  recentInbound.delete(id);
  recentInbound.set(id, now);
  while (recentInbound.size > REQUEST_ORIGIN_MAX_ENTRIES) {
    const oldest = recentInbound.keys().next().value;
    if (oldest === undefined) break;
    recentInbound.delete(oldest);
  }
}

/** Exact fresh-equality lookup against the inbound registry. No other id can satisfy it. */
export function matchInboundRequestId(id: string, now = Date.now()): boolean {
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return false;
  prune(now);
  return recentInbound.has(id);
}

/**
 * Registers or revalidates one direct-A candidate and answers whether its exact id currently
 * matches a fresh inbound MCP request id.
 *
 * The first accepted offer binds the candidate to its conversation and document tuple for the
 * candidate's whole lifetime. A later offer of the same id from another conversation or
 * document is a conflict: an old document can never become authority in the new one, and a
 * candidate that has already expired is stale even if an inbound id for it arrives later.
 */
export function authorizeDirectOriginOffer(offer: DirectOriginOffer, now = Date.now()): DirectOriginVerdict {
  if (!offer || typeof offer !== 'object') return 'malformed';
  if (typeof offer.requestId !== 'string' || !REQUEST_ID.test(offer.requestId)) return 'malformed';
  if (typeof offer.conversationId !== 'string' || !CONVERSATION_ID.test(offer.conversationId)) return 'malformed';
  if (!validDocument(offer.document)) return 'malformed';
  if (typeof offer.observedAt !== 'number' || !Number.isFinite(offer.observedAt)) return 'malformed';
  if (offer.observedAt > now + OBSERVED_AT_FUTURE_SKEW_MS) return 'malformed';
  if (now - offer.observedAt > REQUEST_ORIGIN_TTL_MS) return 'stale';

  prune(now);
  const existing = directCandidates.get(offer.requestId);
  if (existing) {
    if (existing.conversationId !== offer.conversationId || !sameDocument(existing.document, offer.document)) {
      return 'conflict';
    }
    return matchInboundRequestId(offer.requestId, now) ? 'paired' : 'awaiting_inbound';
  }

  if (directCandidates.size >= REQUEST_ORIGIN_MAX_ENTRIES) {
    const oldest = directCandidates.keys().next().value;
    if (oldest !== undefined) directCandidates.delete(oldest);
  }
  directCandidates.set(offer.requestId, {
    requestId: offer.requestId,
    conversationId: offer.conversationId,
    document: { ...offer.document },
    observedAt: offer.observedAt,
    storedAt: now
  });
  return matchInboundRequestId(offer.requestId, now) ? 'paired' : 'awaiting_inbound';
}

/** Retained sizes after pruning; test/diagnostic inspection only. */
export function requestOriginRegistrySizes(now = Date.now()): { inbound: number; candidates: number } {
  prune(now);
  return { inbound: recentInbound.size, candidates: directCandidates.size };
}

/** Test seam. Product code never clears these registries: entries expire on their own. */
export function resetRequestOriginStateForTests(): void {
  recentInbound.clear();
  directCandidates.clear();
}
