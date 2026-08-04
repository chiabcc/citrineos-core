// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import { QueryTypes } from 'sequelize';
import type { IMessageConfirmation } from '@citrineos/base';
import {
  AbstractModuleApi,
  AsDataEndpoint,
  HttpMethod,
  Namespace,
  OCPP1_6_Namespace,
  QuerySchema,
} from '@citrineos/base';
import {
  Authorization,
  ChangeConfiguration,
  ChargingStation,
  Connector,
  Evse,
} from '@dal/layers/sequelize/index.js';
import type { IProvisioningModuleApi } from './interface.js';
import { ProvisioningModule } from './module.js';
import { StationAuthorization } from '../model/StationAuthorization.js';
import { planTopology, type CreateConnectorInput, type CreateEvseInput } from './topology.js';
import {
  deletionStatement,
  STATION_DELETION_ORDER,
  TRANSACTION_COUNT_SQL,
  validateDeletionOrder,
} from './station-deletion.js';

interface TenantQuerystring {
  tenantId: number;
}

interface ListChargingStationsQuerystring extends TenantQuerystring {
  stationId?: string;
}

interface ListChangeConfigurationsQuerystring extends TenantQuerystring {
  stationId: string;
  key?: string;
}

interface DeleteChargingStationQuerystring extends TenantQuerystring {
  stationId: string;
  force?: boolean;
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

// Read side of the OCPP 1.6 configuration store. The Configuration module's
// GetConfiguration handler upserts every configurationKey a station answers
// into ChangeConfigurations, but nothing exposed it — this is the only way an
// external system can read a 1.6 station's configuration without re-asking the
// station itself.
const ListChangeConfigurationsQuerySchema = QuerySchema('ListChangeConfigurationsQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
  { key: 'stationId', type: 'string', required: true },
  { key: 'key', type: 'string' },
]);

interface UpdateChargingStationTopologyRequest {
  stationId: string;
  /** Full desired topology — same shape the create takes. The endpoint diffs it
   *  against what exists rather than replacing blindly. */
  evses: CreateEvseInput[];
}

const UpdateChargingStationTopologyRequestSchema = {
  $id: 'UpdateChargingStationTopologyRequestSchema',
  type: 'object',
  properties: {
    stationId: { type: 'string' },
    evses: { type: 'array' },
  },
  required: ['stationId', 'evses'],
} as const;

// stationId is required here, unlike the GET: an omitted filter listing every
// station is harmless, an omitted filter deleting every station is not.
const DeleteChargingStationQuerySchema = QuerySchema('DeleteChargingStationQuerySchema', [
  { key: 'tenantId', type: 'number', required: true, defaultValue: '1' },
  { key: 'stationId', type: 'string', required: true },
  { key: 'force', type: 'boolean' },
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
 * - POST   /data/provisioning/chargingStation — create station + EVSEs + connectors in one transaction
 * - GET    /data/provisioning/chargingStation — list stations (optionally one) with topology summary
 * - DELETE /data/provisioning/chargingStation — permanently remove a station and its children
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

  /**
   * Correct a station's topology after onboarding (changcharge ADR: topology
   * edit). The wizard asks once and reality changes anyway — a mis-counted
   * connector, a hardware swap under the same station id, firmware that
   * renumbers.
   *
   * Diff semantics, in one transaction:
   *   - a connectorId in the request but not the DB is created
   *   - one in both is updated in place (type / powerType / max power / EVSE grouping)
   *   - one only in the DB is removed — but ONLY if no transaction ever ran on
   *     it. Removing recorded history is what DELETE ../chargingStation?force
   *     is for; an edit endpoint must never do it as a side effect.
   *
   * Status rows for a removed connector (StatusNotifications and the latest
   * pointer) go with it; they describe hardware the owner says does not exist.
   */
  @AsDataEndpoint(
    Namespace.ChargingStation,
    HttpMethod.Put,
    ProvisioningTenantQuerySchema,
    UpdateChargingStationTopologyRequestSchema,
  )
  async updateChargingStationTopology(
    request: FastifyRequest<{
      Body: UpdateChargingStationTopologyRequest;
      Querystring: TenantQuerystring;
    }>,
  ): Promise<IMessageConfirmation> {
    const tenantId = request.query.tenantId;
    const { stationId, evses: evseInput } = request.body;

    if (!evseInput?.length) {
      return { success: false, payload: 'evses must not be empty' };
    }

    const station = await ChargingStation.findOne({ where: { id: stationId, tenantId } });
    if (!station) {
      return { success: false, payload: `Charging station ${stationId} not found` };
    }

    const plan = planTopology({ evses: evseInput });

    try {
      const result = await ChargingStation.sequelize!.transaction(async (transaction) => {
        const existing = await Connector.findAll({
          where: { stationId, tenantId },
          transaction,
        });
        const wanted = new Map(plan.map((row) => [row.connectorId, row]));
        const present = new Map(existing.map((c) => [c.connectorId, c]));

        // Removals first, and only of connectors no transaction ever used —
        // checked per connector, not per station, so adding a second connector
        // to a station with history still works.
        const removed: number[] = [];
        for (const conn of existing) {
          if (wanted.has(conn.connectorId)) continue;
          // Transactions FK the connector row's database id (not the OCPP
          // number) in their own "connectorId" column.
          const [{ count }] = (await ChargingStation.sequelize!.query(
            `SELECT count(*)::int AS count FROM "Transactions"
              WHERE "stationId" = :stationId AND "connectorId" = :dbId`,
            {
              replacements: { stationId, dbId: conn.id },
              type: QueryTypes.SELECT,
              transaction,
            },
          )) as { count: number }[];
          if (count > 0) {
            throw new Error(
              `connector ${conn.connectorId} has ${count} transaction(s); refusing to remove it — history removal is DELETE's job`,
            );
          }
          // Status rows key on the OCPP connector NUMBER (unlike Transactions,
          // which FK the row's database id). The latest-pointer table has no
          // connector column at all — it references StatusNotifications rows —
          // so clear the pointers first, then the log they point into.
          await ChargingStation.sequelize!.query(
            `DELETE FROM "LatestStatusNotifications"
              WHERE "stationId" = :stationId
                AND "statusNotificationId" IN (
                  SELECT id FROM "StatusNotifications"
                   WHERE "stationId" = :stationId AND "connectorId" = :connectorNo)`,
            { replacements: { stationId, connectorNo: conn.connectorId }, transaction },
          );
          await ChargingStation.sequelize!.query(
            `DELETE FROM "StatusNotifications" WHERE "stationId" = :stationId AND "connectorId" = :connectorNo`,
            { replacements: { stationId, connectorNo: conn.connectorId }, transaction },
          );
          await conn.destroy({ transaction });
          removed.push(conn.connectorId);
        }

        // EVSE rows for the target shape — create the missing ones.
        const evseRows = new Map<number, Evse>();
        for (const row of plan) {
          if (evseRows.has(row.evseNo)) continue;
          const [evse] = await Evse.findOrCreate({
            where: { stationId, tenantId, evseTypeId: row.evseNo },
            defaults: {
              tenantId,
              stationId,
              stationPkId: station.pkId,
              evseTypeId: row.evseNo,
              evseId: `${stationId}-${row.evseNo}`,
            },
            transaction,
          });
          evseRows.set(row.evseNo, evse);
        }

        const added: number[] = [];
        const updated: number[] = [];
        for (const row of plan) {
          const evse = evseRows.get(row.evseNo)!;
          const current = present.get(row.connectorId);
          if (!current) {
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
            added.push(row.connectorId);
          } else {
            await current.update(
              {
                evseId: evse.id,
                evseTypeConnectorId: row.evseConnectorId,
                type: row.connector.type,
                powerType: row.connector.powerType,
                maximumPowerWatts: row.connector.maxPowerW,
              },
              { transaction },
            );
            updated.push(row.connectorId);
          }
        }

        // EVSEs that no connector points at anymore are hardware the owner
        // says is gone too.
        const keptEvseNos = new Set(plan.map((r) => r.evseNo));
        const allEvses = await Evse.findAll({ where: { stationId, tenantId }, transaction });
        const removedEvses: number[] = [];
        for (const evse of allEvses) {
          const evseNo = evse.evseTypeId;
          // An EVSE without a number was not created by our topology flow —
          // leave it alone rather than guess whether it is still wanted.
          if (evseNo === undefined || keptEvseNos.has(evseNo)) continue;
          const stillUsed = await Connector.count({ where: { evseId: evse.id }, transaction });
          if (stillUsed === 0) {
            await evse.destroy({ transaction });
            removedEvses.push(evseNo);
          }
        }

        return { added, updated, removed, removedEvses };
      });

      this._logger.info(
        `Updated topology of ${stationId} (tenant ${tenantId}): +${result.added.length} ~${result.updated.length} -${result.removed.length}`,
      );
      return { success: true, payload: { stationId, ...result } };
    } catch (error) {
      this._logger.error(`Failed updating topology of ${stationId}`, error);
      return {
        success: false,
        payload: error instanceof Error ? error.message : `Failed updating topology of ${stationId}`,
      };
    }
  }

  /**
   * Permanently remove a station and every row that hangs off it.
   *
   * WHY: CitrineOS has no delete, and the database cannot do it either — the
   * `populate_station_pk_id` trigger re-resolves `stationPkId` on the UPDATE
   * that `ON DELETE SET NULL` issues, so a plain DELETE of the station aborts
   * instead of cascading. Without this endpoint a factory-locked charger that
   * changes owner is stuck forever: the new owner must onboard under the same
   * serial, and `createChargingStation` answers "already exists".
   *
   * The order the rows go in lives in station-deletion.ts, derived from the FK
   * graph and unit tested; this method only executes it, in one transaction so
   * a mistake rolls back rather than half-erasing a station.
   */
  @AsDataEndpoint(Namespace.ChargingStation, HttpMethod.Delete, DeleteChargingStationQuerySchema)
  async deleteChargingStation(
    request: FastifyRequest<{ Querystring: DeleteChargingStationQuerystring }>,
  ): Promise<IMessageConfirmation> {
    const { tenantId, stationId, force = false } = request.query;
    const replacements = { stationId, tenantId };

    // Cheap insurance against a bad edit to the plan reaching production data:
    // the unit test proves the shipped order is sound, this proves the order in
    // the running process is the one that was tested.
    const violations = validateDeletionOrder();
    if (violations.length > 0) {
      this._logger.error(
        `Refusing to delete ${stationId}; deletion plan is inconsistent`,
        violations,
      );
      return { success: false, payload: `Deletion plan is inconsistent: ${violations.join('; ')}` };
    }

    const station = await ChargingStation.findOne({ where: { id: stationId, tenantId } });
    if (!station) {
      // Idempotent: a second delete, or a delete racing another one, is not an
      // error — the caller's goal (id is free) already holds.
      return { success: false, payload: `Charging station ${stationId} does not exist` };
    }

    const sequelize = ChargingStation.sequelize!;

    // Charging history is a user's billing record, not the station's. Erasing it
    // has to be asked for explicitly, so an accidental call cannot take it.
    const [{ count: transactionCount }] = await sequelize.query<{ count: number }>(
      TRANSACTION_COUNT_SQL,
      { replacements, type: QueryTypes.SELECT },
    );
    if (transactionCount > 0 && !force) {
      return {
        success: false,
        payload: `Charging station ${stationId} has ${transactionCount} transaction(s); pass force=true to delete them too`,
      };
    }

    try {
      const deleted = await sequelize.transaction(async (transaction) => {
        const counts: Record<string, number> = {};
        for (const step of STATION_DELETION_ORDER) {
          const [{ count }] = await sequelize.query<{ count: number }>(deletionStatement(step), {
            replacements,
            transaction,
            type: QueryTypes.SELECT,
          });
          // Report only what was actually there; a wall of zeroes hides the row
          // that mattered.
          if (count > 0) {
            counts[step.table] = count;
          }
        }
        return counts;
      });

      const rows = Object.values(deleted).reduce((sum, n) => sum + n, 0);
      this._logger.info(
        `Deleted charging station ${stationId} (tenant ${tenantId}): ${rows} row(s) across ${Object.keys(deleted).length} table(s)`,
        deleted,
      );
      return { success: true, payload: { stationId, rows, deleted } };
    } catch (error) {
      // The transaction rolled back, so the station is still whole.
      this._logger.error(`Failed deleting charging station ${stationId}`, error);
      return {
        success: false,
        payload: `Failed deleting charging station ${stationId}: ${(error as Error).message}`,
      };
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

  /** OCPP 1.6 configuration as last learned from the station (GET /data/provisioning/changeConfiguration) */
  @AsDataEndpoint(OCPP1_6_Namespace.ChangeConfiguration, HttpMethod.Get, ListChangeConfigurationsQuerySchema)
  async listChangeConfigurations(
    request: FastifyRequest<{ Querystring: ListChangeConfigurationsQuerystring }>,
  ): Promise<IMessageConfirmation> {
    const { tenantId, stationId, key } = request.query;
    const where = key ? { tenantId, stationId, key } : { tenantId, stationId };

    const rows = await ChangeConfiguration.findAll({ where, order: [['key', 'ASC']] });
    const payload = rows.map((row) => ({
      key: row.key,
      value: row.value ?? null,
      readonly: row.readonly ?? null,
      updatedAt: row.updatedAt,
    }));

    return { success: true, payload };
  }

  /**
   * Overrides superclass method to generate the URL path based on the input {@link Namespace}
   * and the module's endpoint prefix configuration.
   */
  protected _toDataPath(input: Namespace | OCPP1_6_Namespace): string {
    const endpointPrefix = this._module.config.modules.provisioning?.endpointPrefix ?? 'provisioning';
    return super._toDataPath(input, endpointPrefix);
  }
}
