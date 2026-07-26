// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Pure scope decision — deliberately free of imports so it can be unit tested
// without the server. The literals match AuthorizationStatusEnum.

export type ScopeDecision = 'Accepted' | 'Blocked';

/**
 * Decide whether a token restricted to certain stations may be used at this one.
 *
 * Reached only for tokens that are already Accepted, so the only question left
 * is location. Wrong in either direction is a security bug: too loose and
 * someone else's card starts a charge on your box, too strict and the owner is
 * locked out of their own.
 */
export function decideStationScope(
  scopedStationIds: string[],
  stationId: string,
): ScopeDecision {
  // No scope rows means the token was never restricted — the pre-existing
  // behaviour for global tags, which must keep working.
  if (scopedStationIds.length === 0) return 'Accepted';
  return scopedStationIds.includes(stationId) ? 'Accepted' : 'Blocked';
}
