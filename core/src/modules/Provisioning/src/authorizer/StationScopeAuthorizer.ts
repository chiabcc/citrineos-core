// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  type AuthorizationStatusEnumType,
  type AuthorizationDto,
  type IAuthorizer,
  type IMessageContext,
} from '@citrineos/base';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import { StationAuthorization } from '../model/StationAuthorization.js';
import { decideStationScope } from './station-scope.js';

/**
 * StationScopeAuthorizer — restricts an idToken to specific charging stations.
 *
 * Reached only after the Authorization row exists and its status is Accepted
 * (both the EVDriver Authorize handler and the Transactions StartTransaction path
 * run the authorizer chain only for already-Accepted tokens and stop on the first
 * non-Accepted result). Therefore:
 *   - no StationAuthorizations rows for this token -> global tag -> Accepted (backward compatible)
 *   - rows exist and include context.stationId     -> Accepted
 *   - rows exist but exclude context.stationId      -> Blocked
 */
export class StationScopeAuthorizer implements IAuthorizer {
  private readonly _logger: Logger<ILogObj>;

  constructor(logger?: Logger<ILogObj>) {
    this._logger = logger
      ? logger.getSubLogger({ name: this.constructor.name })
      : new Logger<ILogObj>({ name: this.constructor.name });
  }

  async authorize(
    authorization: AuthorizationDto,
    context: IMessageContext,
  ): Promise<AuthorizationStatusEnumType> {
    const scopes = await StationAuthorization.findAll({
      where: { tenantId: context.tenantId, authorizationId: authorization.id },
      attributes: ['stationId'],
    });

    const scopedStationIds = scopes.map((s) => s.stationId);
    const decision = decideStationScope(scopedStationIds, context.stationId) as AuthorizationStatusEnumType;
    this._logger.debug(
      scopedStationIds.length === 0
        ? `Authorization ${authorization.id} has no station scope; treating as global (Accepted) at station ${context.stationId}`
        : `Authorization ${authorization.id} scoped to [${scopedStationIds.join(', ')}]; station ${context.stationId} -> ${decision}`,
    );
    return decision;
  }
}
