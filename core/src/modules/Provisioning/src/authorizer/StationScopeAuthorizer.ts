// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  AuthorizationStatusEnum,
  type AuthorizationStatusEnumType,
  type AuthorizationDto,
  type IAuthorizer,
  type IMessageContext,
} from '@citrineos/base';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import { StationAuthorization } from '../model/StationAuthorization.js';

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

    if (scopes.length === 0) {
      this._logger.debug(
        `Authorization ${authorization.id} has no station scope; treating as global (Accepted) at station ${context.stationId}`,
      );
      return AuthorizationStatusEnum.Accepted;
    }

    const allowed = scopes.some((s) => s.stationId === context.stationId);
    this._logger.debug(
      `Authorization ${authorization.id} scoped to [${scopes
        .map((s) => s.stationId)
        .join(', ')}]; station ${context.stationId} -> ${allowed ? 'Accepted' : 'Blocked'}`,
    );
    return allowed ? AuthorizationStatusEnum.Accepted : AuthorizationStatusEnum.Blocked;
  }
}
