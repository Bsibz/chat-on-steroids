/**
 * The process-local equality gate between a direct-A conversation SSE observation and a real
 * normalized inbound MCP `x-request-id`.
 *
 * These tests are about what the gate refuses as much as what it pairs: no timing, ordering,
 * conversation inference or "only active request" guess may ever turn an unpaired observation
 * into ownership evidence. The durable correlation registry is untouched here — this module
 * grants nothing by itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  REQUEST_ORIGIN_MAX_ENTRIES,
  REQUEST_ORIGIN_TTL_MS,
  authorizeDirectOriginOffer,
  matchInboundRequestId,
  rememberInboundRequestId,
  requestOriginRegistrySizes,
  resetRequestOriginStateForTests,
  type DirectOriginOffer
} from '../src/main/request-origin.js';

const CONVERSATION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_CONVERSATION = '11111111-2222-4333-8444-555555555555';
const DOCUMENT = { tab: 7, documentId: 'document-7-0', navigationEpoch: 3 };

function offer(requestId: string, overrides: Partial<DirectOriginOffer> = {}): DirectOriginOffer {
  return {
    requestId,
    conversationId: CONVERSATION,
    observedAt: 1_000,
    document: { ...DOCUMENT },
    ...overrides
  };
}

beforeEach(() => resetRequestOriginStateForTests());

describe('direct request-origin equality', () => {
  it('pairs when the inbound id arrived first', () => {
    rememberInboundRequestId('wfr_inbound_first', 1_000);
    expect(authorizeDirectOriginOffer(offer('wfr_inbound_first'), 1_100)).toBe('paired');
  });

  it('pairs when the SSE observation arrived first', () => {
    expect(authorizeDirectOriginOffer(offer('wfr_sse_first'), 1_000)).toBe('awaiting_inbound');
    rememberInboundRequestId('wfr_sse_first', 1_500);
    expect(authorizeDirectOriginOffer(offer('wfr_sse_first'), 1_600)).toBe('paired');
  });

  it('keeps concurrent distinct requests bound to their own exact ids', () => {
    rememberInboundRequestId('wfr_left', 1_000);
    expect(authorizeDirectOriginOffer(offer('wfr_left'), 1_100)).toBe('paired');
    expect(authorizeDirectOriginOffer(offer('wfr_right'), 1_100)).toBe('awaiting_inbound');
    rememberInboundRequestId('wfr_right', 1_200);
    expect(authorizeDirectOriginOffer(offer('wfr_right'), 1_300)).toBe('paired');
    expect(authorizeDirectOriginOffer(offer('wfr_absent'), 1_300)).toBe('awaiting_inbound');
  });

  it('never pairs on timing, presence or a similar id', () => {
    expect(authorizeDirectOriginOffer(offer('wfr_waiting'), 1_000)).toBe('awaiting_inbound');
    rememberInboundRequestId('wfr_someone_else', 2_000);
    // Waiting inside the TTL and another fresh inbound id must not satisfy equality.
    expect(authorizeDirectOriginOffer(offer('wfr_waiting'), 2_500)).toBe('awaiting_inbound');
    expect(matchInboundRequestId('wfr_waiting/att1', 2_500)).toBe(false);
    expect(matchInboundRequestId('wfr_waiting_x', 2_500)).toBe(false);
  });

  it('expires a candidate five minutes after its first offer even if it is re-offered', () => {
    expect(authorizeDirectOriginOffer(offer('wfr_dying'), 1_000)).toBe('awaiting_inbound');
    // A re-offer inside the window keeps the original anchor and still does not exist inbound.
    expect(authorizeDirectOriginOffer(offer('wfr_dying'), 1_000 + REQUEST_ORIGIN_TTL_MS - 1)).toBe('awaiting_inbound');
    // A fresh inbound id that arrives after the anchor expired cannot revive the candidate.
    rememberInboundRequestId('wfr_dying', 1_000 + REQUEST_ORIGIN_TTL_MS + 1);
    expect(authorizeDirectOriginOffer(offer('wfr_dying'), 1_000 + REQUEST_ORIGIN_TTL_MS + 2)).toBe('stale');
  });

  it('rejects an observation older than the TTL on its first offer', () => {
    rememberInboundRequestId('wfr_old_sighting', 1_000);
    expect(authorizeDirectOriginOffer(offer('wfr_old_sighting'), 1_000 + REQUEST_ORIGIN_TTL_MS + 1)).toBe('stale');
  });

  it('expires an inbound id five minutes after its last sighting', () => {
    rememberInboundRequestId('wfr_inbound_expiry', 1_000);
    expect(matchInboundRequestId('wfr_inbound_expiry', 1_000 + REQUEST_ORIGIN_TTL_MS - 1)).toBe(true);
    expect(matchInboundRequestId('wfr_inbound_expiry', 1_000 + REQUEST_ORIGIN_TTL_MS)).toBe(false);
    expect(authorizeDirectOriginOffer(offer('wfr_inbound_expiry'), 1_000 + REQUEST_ORIGIN_TTL_MS + 1)).toBe('stale');
  });

  it('rejects a candidate rebound to another conversation or document', () => {
    expect(authorizeDirectOriginOffer(offer('wfr_bound'), 1_000)).toBe('awaiting_inbound');
    expect(authorizeDirectOriginOffer(offer('wfr_bound', { conversationId: OTHER_CONVERSATION }), 1_100)).toBe('conflict');
    expect(authorizeDirectOriginOffer(offer('wfr_bound', { document: { ...DOCUMENT, documentId: 'document-8-0' } }), 1_100)).toBe('conflict');
    expect(authorizeDirectOriginOffer(offer('wfr_bound', { document: { ...DOCUMENT, navigationEpoch: 4 } }), 1_100)).toBe('conflict');
    expect(authorizeDirectOriginOffer(offer('wfr_bound'), 1_100)).toBe('awaiting_inbound');
  });

  it('rejects malformed offers and malformed inbound ids', () => {
    expect(authorizeDirectOriginOffer(offer('has spaces'), 1_000)).toBe('malformed');
    expect(authorizeDirectOriginOffer(offer('wfr_bad_conversation', { conversationId: 'not-a-uuid' }), 1_000)).toBe('malformed');
    expect(authorizeDirectOriginOffer(offer('wfr_bad_document', { document: { tab: -1, documentId: 'd', navigationEpoch: 0 } }), 1_000)).toBe('malformed');
    expect(authorizeDirectOriginOffer(offer('wfr_bad_document', { document: { tab: 1, documentId: '', navigationEpoch: 0 } }), 1_000)).toBe('malformed');
    expect(authorizeDirectOriginOffer(offer('wfr_future', { observedAt: 1_000 + 60_001 }), 1_000)).toBe('malformed');
    expect(authorizeDirectOriginOffer(offer('wfr_nan', { observedAt: Number.NaN }), 1_000)).toBe('malformed');
    rememberInboundRequestId('has spaces', 1_000);
    expect(matchInboundRequestId('has spaces', 1_000)).toBe(false);
    expect(matchInboundRequestId('wfr_valid_but_unknown', 1_000)).toBe(false);
  });

  it('bounds both registries and evicts the oldest entry', () => {
    for (let index = 0; index < REQUEST_ORIGIN_MAX_ENTRIES + 1; index += 1) {
      rememberInboundRequestId(`wfr_in_${index}`, 1_000 + index);
      expect(authorizeDirectOriginOffer(offer(`wfr_cand_${index}`), 1_000 + index)).toBe('awaiting_inbound');
    }
    const sizes = requestOriginRegistrySizes(2_000);
    expect(sizes.inbound).toBe(REQUEST_ORIGIN_MAX_ENTRIES);
    expect(sizes.candidates).toBe(REQUEST_ORIGIN_MAX_ENTRIES);
    expect(matchInboundRequestId('wfr_in_0', 2_000)).toBe(false);
    expect(matchInboundRequestId(`wfr_in_${REQUEST_ORIGIN_MAX_ENTRIES}`, 2_000)).toBe(true);
    // The evicted candidate is genuinely gone: its inbound id cannot pair it any more.
    rememberInboundRequestId('wfr_cand_0', 2_000);
    expect(authorizeDirectOriginOffer(offer('wfr_cand_0'), 2_000)).toBe('paired');
  });

  it('prunes expired entries on read', () => {
    rememberInboundRequestId('wfr_prune_in', 0);
    expect(authorizeDirectOriginOffer(offer('wfr_prune_cand'), 0)).toBe('awaiting_inbound');
    expect(requestOriginRegistrySizes(REQUEST_ORIGIN_TTL_MS)).toEqual({ inbound: 0, candidates: 0 });
  });
});
