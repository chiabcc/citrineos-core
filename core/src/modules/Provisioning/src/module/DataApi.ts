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

interface TenantQuerystring {
  tenantId: number;
}

interface ListChargingStationsQuerystring extends TenantQuerystring {
  stationId?: string;
}

interface CreateChargingStationRequest {
  stationId: string;
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
}

const CreateAuthorizationRequestSchema = {
  $id: 'CreateAuthorizationRequestSchema',
  type: 'object',
  properties: {
    idToken: { type: 'string', minLength: 1, maxLength: 36 },
    idTokenType: { type: 'string', default: 'ISO14443' },
  },
  required: ['idToken'],
  additionalProperties: false,
};

const CreateChargingStationRequestSchema = {
  $id: 'CreateChargingStationRequestSchema',
  type: 'object',
  properties: {
    // Station identity used in the OCPP-J WebSocket URL path — keep charset URL-safe
    stationId: { type: 'string', minLength: 1, maxLength: 36, pattern: '^[A-Za-z0-9._:|@-]+$' },
    // OCPP 1.6 chargers cannot report their topology; caller must declare it.
    // Modeled as 1 EVSE per connector (evseTypeId N ↔ connectorId N).
    connectorCount: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
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
    const { stationId, connectorCount = 1, chargePointVendor, chargePointModel } = request.body;

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
        const evses: { evseTypeId: number; connectorId: number }[] = [];
        for (let i = 1; i <= connectorCount; i++) {
          const evse = await Evse.create(
            {
              tenantId,
              stationId,
              stationPkId: station.pkId,
              evseTypeId: i,
              evseId: `${stationId}-${i}`,
            },
            { transaction },
          );
          await Connector.create(
            {
              tenantId,
              stationId,
              connectorId: i,
              evseId: evse.id,
              evseTypeConnectorId: 1,
              status: 'Unknown',
            },
            { transaction },
          );
          evses.push({ evseTypeId: i, connectorId: i });
        }
        return { pkId: station.pkId, evses };
      });

      this._logger.info(
        `Provisioned charging station ${stationId} (tenant ${tenantId}) with ${connectorCount} connector(s)`,
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
    const { idToken, idTokenType = 'ISO14443' } = request.body;
    const [row] = await Authorization.findOrCreate({
      where: { tenantId, idToken },
      defaults: { tenantId, idToken, idTokenType, status: 'Accepted' },
    });
    return { success: true, payload: { id: row.id, idToken } };
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
