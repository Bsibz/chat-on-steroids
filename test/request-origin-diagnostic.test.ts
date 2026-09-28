import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES,
  REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS,
  matchInboundRequestOrigin,
  rememberInboundRequestOrigin,
  requestOriginDiagnosticSize,
  requestOriginDigest,
  resetRequestOriginDiagnostics
} from '../src/main/request-origin-diagnostic.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

describe('request-origin diagnostic registry', () => {
  it('derives the same lowercase SHA-256 hex the browser observer computes', () => {
    resetRequestOriginDiagnostics();
    const id = 'wfr_0123456789abcdef0123456789abcdef';
    expect(requestOriginDigest(id)).toBe(sha256(id));
    expect(requestOriginDigest(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestOriginDigest(id)).not.toBe(requestOriginDigest(`${id}x`));
  });

  it('matches an exact digest and reports its age', () => {
    resetRequestOriginDiagnostics();
    const now = 1_000_000;
    rememberInboundRequestOrigin('wfr_exact', now);
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_exact'), now)).toBe(0);
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_exact'), now + 1234)).toBe(1234);
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_other'), now)).toBeNull();
  });

  it('expires a match at the TTL boundary and prunes it on read', () => {
    resetRequestOriginDiagnostics();
    const now = 5_000_000;
    rememberInboundRequestOrigin('wfr_stale', now);
    const digest = requestOriginDigest('wfr_stale');
    expect(matchInboundRequestOrigin(digest, now + REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS - 1)).toBe(REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS - 1);
    expect(matchInboundRequestOrigin(digest, now + REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS)).toBeNull();
    expect(requestOriginDiagnosticSize(now + REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS)).toBe(0);
  });

  it('prunes expired entries on insert without evicting a fresh one', () => {
    resetRequestOriginDiagnostics();
    rememberInboundRequestOrigin('wfr_old', 0);
    rememberInboundRequestOrigin('wfr_new', REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS);
    expect(requestOriginDiagnosticSize(REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS)).toBe(1);
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_old'), REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS)).toBeNull();
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_new'), REQUEST_ORIGIN_DIAGNOSTIC_TTL_MS)).toBe(0);
  });

  it('bounds the registry and keeps the most recently seen ids', () => {
    resetRequestOriginDiagnostics();
    const now = 2_000_000;
    for (let index = 0; index < REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES + 10; index++) {
      rememberInboundRequestOrigin(`wfr_${index}`, now);
    }
    expect(requestOriginDiagnosticSize(now)).toBe(REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES);
    // The first ids fell out; the last ones are retained.
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_0'), now)).toBeNull();
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_9'), now)).toBeNull();
    const last = REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES + 9;
    expect(matchInboundRequestOrigin(requestOriginDigest(`wfr_${last}`), now)).toBe(0);
    // Re-seeing an id refreshes it instead of adding a duplicate.
    const digest = requestOriginDigest(`wfr_${last}`);
    rememberInboundRequestOrigin(`wfr_${last}`, now);
    expect(requestOriginDiagnosticSize(now)).toBe(REQUEST_ORIGIN_DIAGNOSTIC_MAX_ENTRIES);
    expect(matchInboundRequestOrigin(digest, now + 7)).toBe(7);
  });

  it('rejects malformed digests and malformed registrations without throwing', () => {
    resetRequestOriginDiagnostics();
    const now = 1_000_000;
    rememberInboundRequestOrigin('wfr_valid', now);
    const valid = requestOriginDigest('wfr_valid');
    expect(matchInboundRequestOrigin(valid, now)).toBe(0);
    for (const malformed of ['', 'not-hex', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64),
      `${'a'.repeat(64)} `, undefined, null, 7, {}, []]) {
      expect(matchInboundRequestOrigin(malformed as unknown as string)).toBeNull();
    }
    for (const rejected of ['', 'x'.repeat(101), undefined, null, 7, {}]) {
      rememberInboundRequestOrigin(rejected as unknown as string);
    }
    expect(requestOriginDiagnosticSize(now)).toBe(1);
    expect(matchInboundRequestOrigin(valid, now)).toBe(0);
  });

  it('clears only through the test seam', () => {
    resetRequestOriginDiagnostics();
    rememberInboundRequestOrigin('wfr_seam');
    expect(requestOriginDiagnosticSize()).toBe(1);
    resetRequestOriginDiagnostics();
    expect(requestOriginDiagnosticSize()).toBe(0);
    expect(matchInboundRequestOrigin(requestOriginDigest('wfr_seam'))).toBeNull();
  });
});
