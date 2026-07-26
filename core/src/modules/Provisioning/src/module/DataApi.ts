// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import type { IMessageConfirmation } from '@citrineos/base';
import {
  AbstractModuleApi,
  AsDataEndpoint,
  HttpMethod,
  Namespace,
  QuerySchema,
} from '@citrineos/base';
import { Authorization, ChargingStation, Connector, Evse } from '@dal/layers/sequelize/index.js';
import type { IProvisioningModuleApi } from './interface.js';
import { ProvisioningModule } from './module.js';
import { StationAuthorization } from '../model/StationAuthorization.js';
import { planTopology, type CreateConnectorInput, type CreateEvseInput } from './topology.js';

interface TenantQuerystring {
  tenantId: number;
}

interface ListChargingStationsQuerystring extends TenantQuerystring {
  stationId?: string;
}



interface CreateChargingStationRequest {
  stationId: string;
  ocppVersion?: string;
  /**
   * Full topology: one entry per EVSE (= one car served at a time), each with
   * its connectors. An EVSE with two connectors is a station that has, say,
   * CCS2 + CHAdeMO on one supply point and can only run one of them at a time.
   */
  evses?: CreateEvseInput[];
  /** Legacy shorthand: N connectors, one EVSE each. Ignored when `evses` is given. */
  connectorCount?: number;
  chargePointVendor?: string;
  chargePointModel?: string;
}

// Schemas need an $id — AbstractModuleApi's registerSchema silently drops them otherwise
const ProvisioningTenantQuerySchema = QuerySchema('ProvisioningTenantQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
]);

const ListChargingStationsQuerySchema = QuerySchema('ListChargingStationsQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
  { key: 'stationId', type: 'string' },
]);

interface CreateAuthorizationRequest {
  idToken: string;
  idTokenType?: string;
  // When present, scope this token to the given station (StationAuthorizations row).
  stationId?: string;
}

const CreateAuthorizationRequestSchema = {
  $id: 'CreateAuthorizationRequestSchema',
  type: 'object',
  properties: {
    idToken: { type: 'string', minLength: 1, maxLength: 36 },
    idTokenType: { type: 'string', default: 'ISO14443' },
    // Optional station scope. Absent = global tag (usable at any station).
    stationId: { type: 'string', minLength: 1, maxLength: 36, pattern: '^[A-Za-z0-9._:|@-]+$' },
  },
  required: ['idToken'],
  additionalProperties: false,
};

// GET list: tenantId required; optional idToken / stationId filters.
const ListAuthorizationsQuerySchema = QuerySchema('ListAuthorizationsQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
  { key: 'idToken', type: 'string' },
  { key: 'stationId', type: 'string' },
]);

// DELETE: tenantId + idToken required; optional stationId to drop a single scope row.
const DeleteAuthorizationQuerySchema = QuerySchema('DeleteAuthorizationQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
  { key: 'idToken', type: 'string', required: true },
  { key: 'stationId', type: 'string' },
]);

interface ListAuthorizationsQuerystring extends TenantQuerystring {
  idToken?: string;
  stationId?: string;
}

interface DeleteAuthorizationQuerystring extends TenantQuerystring {
  idToken: string;
  stationId?: string;
}

const CreateChargingStationRequestSchema = {
  $id: 'CreateChargingStationRequestSchema',
  type: 'object',
  properties: {
    // Station identity used in the OCPP-J WebSocket URL path — keep charset URL-safe
    stationId: { type: 'string', minLength: 1, maxLength: 36, pattern: '^[A-Za-z0-9._:|@-]+$' },
    ocppVersion: { type: 'string', enum: ['1.6', '2.0.1'], default: '1.6' },
    // OCPP 1.6 stations cannot report their topology; the caller declares it.
    // EVSE : Connector is 1:N — do NOT assume one EVSE per connector.
    evses: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          evseNo: { type: 'integer', minimum: 1, maximum: 8 },
          connectors: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', maxLength: 20 },
                powerType: { type: 'string', maxLength: 20 },
                maxPowerW: { type: 'integer', minimum: 100, maximum: 1000000 },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['evseNo', 'connectors'],
        additionalProperties: false,
      },
    },
    // Legacy shorthand kept so older callers keep working: N connectors, 1 EVSE each.
    connectorCount: { type: 'integer', minimum: 1, maximum: 8 },
    chargePointVendor: { type: 'string', maxLength: 20 },
    chargePointModel: { type: 'string', maxLength: 20 },
  },
  required: ['stationId'],
  additionalProperties: false,
};

/**
 * Server API for the Provisioning module.
 *
 * Endpoints (with endpointPrefix `provisioning`):
 * - POST /data/provisioning/chargingStation — create station + EVSEs + connectors in one transaction
 * - GET  /data/provisioning/chargingStation — list stations (optionally one) with topology summary
 */
export class ProvisioningDataApi
  extends AbstractModuleApi<ProvisioningModule>
  implements IProvisioningModuleApi
{
  constructor(
    provisioningModule: ProvisioningModule,
    server: FastifyInstance,
    logger?: Logger<ILogObj>,
  ) {
    super(provisioningModule, server, null, logger);
  }

  @AsDataEndpoint(
    Namespace.ChargingStation,
    HttpMethod.Post,
    ProvisioningTenantQuerySchema,
    CreateChargingStationRequestSchema,
  )
  async createChargingStation(
    request: FastifyRequest<{
      Body: CreateChargingStationRequest;
      Querystring: TenantQuerystring;
    }>,
  ): Promise<IMessageConfirmation> {
    const tenantId = request.query.tenantId;
    const { stationId, evses: evseInput, connectorCount, chargePointVendor, chargePointModel } =
      request.body;

    const plan = planTopology({ evses: evseInput, connectorCount });

    const existing = await ChargingStation.findOne({ where: { id: stationId, tenantId } });
    if (existing) {
      return { success: false, payload: `Charging station ${stationId} already exists` };
    }

    try {
      const created = await ChargingStation.sequelize!.transaction(async (transaction) => {
        const station = await ChargingStation.create(
          { id: stationId, tenantId, isOnline: false, chargePointVendor, chargePointModel },
          { transaction },
        );
        const evses: { evseTypeId: number; connectorIds: number[] }[] = [];
        const evseRows = new Map<number, any>();
        for (const row of plan) {
          let evse = evseRows.get(row.evseNo);
          if (!evse) {
            evse = await Evse.create(
              {
                tenantId,
                stationId,
                stationPkId: station.pkId,
                evseTypeId: row.evseNo,
                evseId: `${stationId}-${row.evseNo}`,
              },
              { transaction },
            );
            evseRows.set(row.evseNo, evse);
            evses.push({ evseTypeId: row.evseNo, connectorIds: [] });
          }
          await Connector.create(
            {
              tenantId,
              stationId,
              connectorId: row.connectorId,
              evseId: evse.id,
              evseTypeConnectorId: row.evseConnectorId,
              status: 'Unknown',
              type: row.connector.type,
              powerType: row.connector.powerType,
              maximumPowerWatts: row.connector.maxPowerW,
            },
            { transaction },
          );
          evses.find((e) => e.evseTypeId === row.evseNo)!.connectorIds.push(row.connectorId);
        }
        return { pkId: station.pkId, evses };
      });

      this._logger.info(
        `Provisioned charging station ${stationId} (tenant ${tenantId}) with ${new Set(plan.map((r) => r.evseNo)).size} EVSE(s)`,
      );
      return { success: true, payload: { stationId, ...created } };
    } catch (error) {
      this._logger.error(`Failed provisioning charging station ${stationId}`, error);
      return { success: false, payload: `Failed provisioning charging station ${stationId}` };
    }
  }

  /** Idempotent upsert of an idToken authorization (RemoteStart validates against this) */
  @AsDataEndpoint(
    Namespace.AuthorizationData,
    HttpMethod.Post,
    ProvisioningTenantQuerySchema,
    CreateAuthorizationRequestSchema,
  )
  async createAuthorization(
    request: FastifyRequest<{
      Body: CreateAuthorizationRequest;
      Querystring: TenantQuerystring;
    }>,
  ): Promise<IMessageConfirmation> {
    const tenantId = request.query.tenantId;
    const { idToken, idTokenType = 'ISO14443', stationId } = request.body;
    const [row] = await Authorization.findOrCreate({
      where: { tenantId, idToken },
      defaults: { tenantId, idToken, idTokenType, status: 'Accepted' },
    });
    // Optional station scope: upsert the (authorizationId, stationId) row.
    if (stationId) {
      await StationAuthorization.findOrCreate({
        where: { tenantId, authorizationId: row.id, stationId },
        defaults: { tenantId, authorizationId: row.id, stationId },
      });
    }
    return { success: true, payload: { id: row.id, idToken } };
  }

  /**
   * Delete an authorization or one of its station scopes (idempotent).
   * - with stationId: drop just that (authorizationId, stationId) scope row.
   * - without stationId: delete the Authorization and all of its scope rows.
   */
  @AsDataEndpoint(
    Namespace.AuthorizationData,
    HttpMethod.Delete,
    DeleteAuthorizationQuerySchema,
  )
  async deleteAuthorization(
    request: FastifyRequest<{ Querystring: DeleteAuthorizationQuerystring }>,
  ): Promise<IMessageConfirmation> {
    const { tenantId, idToken, stationId } = request.query;
    const authorization = await Authorization.findOne({ where: { tenantId, idToken } });
    if (!authorization) {
      // Idempotent: nothing to delete.
      return { success: true };
    }

    if (stationId) {
      const removed = await StationAuthorization.destroy({
        where: { tenantId, authorizationId: authorization.id, stationId },
      });
      this._logger.info(
        `Removed ${removed} station scope(s) for idToken ${idToken} at station ${stationId} (tenant ${tenantId})`,
      );
      return { success: true };
    }

    // Delete all scope rows first, then the authorization itself.
    await StationAuthorization.destroy({ where: { tenantId, authorizationId: authorization.id } });
    await authorization.destroy();
    this._logger.info(`Deleted authorization idToken ${idToken} (tenant ${tenantId})`);
    return { success: true };
  }

  /** List authorizations with their station scopes; optional idToken / stationId filters. */
  @AsDataEndpoint(Namespace.AuthorizationData, HttpMethod.Get, ListAuthorizationsQuerySchema)
  async listAuthorizations(
    request: FastifyRequest<{ Querystring: ListAuthorizationsQuerystring }>,
  ): Promise<IMessageConfirmation> {
    const { tenantId, idToken, stationId } = request.query;

    // When filtering by station, restrict to authorizations that have a scope row there.
    let authIdFilter: number[] | undefined;
    if (stationId) {
      const scoped = await StationAuthorization.findAll({
        where: { tenantId, stationId },
        attributes: ['authorizationId'],
      });
      authIdFilter = [...new Set(scoped.map((s) => s.authorizationId))];
      if (authIdFilter.length === 0) {
        return { success: true, payload: [] };
      }
    }

    const where: Record<string, unknown> = { tenantId };
    if (idToken) {
      where.idToken = idToken;
    }
    if (authIdFilter) {
      where.id = authIdFilter;
    }

    const authorizations = await Authorization.findAll({ where, order: [['idToken', 'ASC']] });
    const ids = authorizations.map((a) => a.id);
    const scopes = ids.length
      ? await StationAuthorization.findAll({ where: { tenantId, authorizationId: ids } })
      : [];

    const payload = authorizations.map((a) => ({
      id: a.id,
      idToken: a.idToken,
      status: a.status,
      stationIds: scopes.filter((s) => s.authorizationId === a.id).map((s) => s.stationId),
    }));

    return { success: true, payload };
  }

  @AsDataEndpoint(Namespace.ChargingStation, HttpMethod.Get, ListChargingStationsQuerySchema)
  async listChargingStations(
    request: FastifyRequest<{ Querystring: ListChargingStationsQuerystring }>,
  ): Promise<IMessageConfirmation> {
    const { tenantId, stationId } = request.query;
    const where = stationId ? { tenantId, id: stationId } : { tenantId };

    const stations = await ChargingStation.findAll({ where, order: [['id', 'ASC']] });
    const stationIds = stations.map((s) => s.id);
    const connectors = stationIds.length
      ? await Connector.findAll({ where: { tenantId, stationId: stationIds } })
      : [];

    const payload = stations.map((s) => ({
      stationId: s.id,
      pkId: s.pkId,
      isOnline: s.isOnline ?? false,
      protocol: s.protocol ?? null,
      chargePointVendor: s.chargePointVendor ?? null,
      chargePointModel: s.chargePointModel ?? null,
      connectors: connectors
        .filter((c) => c.stationId === s.id)
        .sort((a, b) => (a.connectorId ?? 0) - (b.connectorId ?? 0))
        .map((c) => ({ connectorId: c.connectorId, status: c.status })),
    }));

    return { success: true, payload };
  }

  /**
   * Overrides superclass method to generate the URL path based on the input {@link Namespace}
   * and the module's endpoint prefix configuration.
   */
  protected _toDataPath(input: Namespace): string {
    const endpointPrefix = this._module.config.modules.provisioning?.endpointPrefix ?? 'provisioning';
    return super._toDataPath(input, endpointPrefix);
  }
}
