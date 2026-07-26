// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { decideStationScope } from '../../src/authorizer/station-scope';

// Local start policy: a card registered on one box must not start a charge on
// someone else's. This runs only for tokens CitrineOS already accepted, so what
// is left is purely location — and both ways of being wrong are security bugs,
// not cosmetic ones.

describe('decideStationScope', () => {
  it('accepts an unrestricted token anywhere — the pre-existing global behaviour', () => {
    expect(decideStationScope([], 'ST-ANY')).toBe('Accepted');
  });

  it('accepts a token at a station it is scoped to', () => {
    expect(decideStationScope(['ST-A'], 'ST-A')).toBe('Accepted');
  });

  // The reason the authorizer exists: without it any registered card would open
  // any box on the platform.
  it('blocks a token at a station it is not scoped to', () => {
    expect(decideStationScope(['ST-A'], 'ST-B')).toBe('Blocked');
  });

  it('accepts a card shared across several boxes at each of them', () => {
    expect(decideStationScope(['ST-A', 'ST-B'], 'ST-B')).toBe('Accepted');
    expect(decideStationScope(['ST-A', 'ST-B'], 'ST-C')).toBe('Blocked');
  });

  it('matches station ids exactly — no prefix or case slack', () => {
    expect(decideStationScope(['ST-A'], 'ST-A2')).toBe('Blocked');
    expect(decideStationScope(['ST-A2'], 'ST-A')).toBe('Blocked');
    expect(decideStationScope(['ST-A'], 'st-a')).toBe('Blocked');
  });
});
