// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Pure deletion planning — deliberately free of imports so it can be unit
// tested without the rest of the server.
//
// WHY THIS FILE EXISTS
// CitrineOS ships no way to delete a charging station, and the database will
// not do it for us: every child table carries a BEFORE INSERT OR UPDATE trigger
// (`populate_station_pk_id`) that re-resolves `stationPkId` from `stationId`
// and RAISEs when the station is gone. Ten of the sixteen direct children use
// `ON DELETE SET NULL`, which is exactly such an UPDATE — so a plain
// `DELETE FROM "ChargingStations"` aborts instead of cascading. The rows have
// to be removed explicitly, deepest first.
//
// Getting the order wrong is the dangerous part: a wrong order either aborts
// mid-way (recoverable, we run in one transaction) or — worse — leaves orphans
// behind that make the station id unusable for the next owner. Hence: order as
// data, invariants as code, both unit tested.
//
// HOW THE LISTS BELOW WERE DERIVED (not guessed)
//
//   1. Direct children — the sixteen tables that point at ChargingStations:
//        grep -rl 'ForeignKey(() => ChargingStation)' core/src/dal/layers/sequelize/model/
//      cross-checked against the live schema:
//        SELECT c.conrelid::regclass, a.attname, c.confdeltype
//        FROM pg_constraint c
//        JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
//        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
//        WHERE c.contype = 'f' AND c.confrelid = '"ChargingStations"'::regclass;
//      Both agree exactly, so the model layer is the schema here:
//        cascade  : ChargingStationNetworkProfiles, ChargingStationSequences,
//                   Connectors, Evses, InstalledCertificates, VariableAttributes
//        set null : ChargingStationSecurityInfos, DeleteCertificateAttempts,
//                   EventData, InstallCertificateAttempts,
//                   LatestStatusNotifications, OCPPMessages, SetNetworkProfiles,
//                   StatusNotifications, Transactions, VariableMonitorings
//
//   2. Station-owned tables with no FK at all — they carry a bare `stationId`
//      string, so nothing in the database links them to the station and they
//      would survive as garbage under the reused id:
//        SELECT table_name FROM information_schema.columns
//        WHERE table_schema = 'public' AND column_name = 'stationId';
//      minus the sixteen above =  ChangeConfigurations, ChargingProfiles,
//      ChargingSchedules, CompositeSchedules, LocalListVersions, MessageInfos,
//      Reservations, SecurityEvents, SendLocalLists, StartTransactions,
//      StationAuthorizations, StopTransactions, Subscriptions,
//      TransactionEvents. Plus `Boots`, whose primary key *is* the station id
//      (`bootRepository.readByKey(tenantId, stationId)`), so a `stationId`
//      column search does not find it.
//
//   3. Grandchildren reachable only through the rows above (no station column
//      of their own) — from the full FK graph, restricted to parents in the
//      plan: MeterValues, ChargingNeeds, SalesTariffs, VariableStatuses,
//      VariableMonitoringStatuses, LocalListVersionAuthorizations,
//      SendLocalListAuthorizations.
//
// Deliberately NOT deleted: shared dictionaries and tenant-level rows that
// merely happen to be referenced from a station's rows — Authorizations,
// LocalListAuthorizations, Certificates, Components, Variables, EvseTypes,
// Tariffs, Locations, ServerNetworkProfiles. They outlive the station on
// purpose; removing them would break every other station on the tenant.

export type OnDelete = 'cascade' | 'set null' | 'no action';

export interface ForeignKeyEdge {
  /** Table holding the referencing column. */
  child: string;
  column: string;
  /** Table being referenced. */
  parent: string;
  onDelete: OnDelete;
}

export interface DeletionStep {
  /** Postgres table name, unquoted. */
  table: string;
  /**
   * Row-selecting predicate. Only `:stationId` and `:tenantId` are ever bound;
   * everything else is a literal in this file, so no caller input reaches SQL.
   */
  where: string;
}

/** Root of the plan — the table every step below ultimately hangs off. */
export const STATION_TABLE = 'ChargingStations';

/** Predicate for a table that carries the station id directly. */
const byStationId = '"stationId" = :stationId AND "tenantId" = :tenantId';

/** Predicate for rows reachable only through a parent that carries it. */
const viaParent = (column: string, parentTable: string, parentKey: string) =>
  `"${column}" IN (SELECT "${parentKey}" FROM "${parentTable}" WHERE ${byStationId})`;

/**
 * Every foreign key that constrains the order, i.e. both ends are in the plan.
 * Copied from the live `pg_constraint` graph (query in the header comment);
 * edges pointing at tables we keep are omitted because they cannot constrain us.
 *
 * `no action` edges are the ones that hard-fail: ChargingNeeds → Transactions
 * and VariableMonitoringStatuses → VariableMonitorings will abort the
 * transaction outright if their parent goes first. The `set null` edges are the
 * quiet ones — they succeed while the trigger silently re-fills the column, or
 * abort with a confusing "No ChargingStation found" from deep inside a cascade.
 */
export const STATION_FOREIGN_KEYS: ForeignKeyEdge[] = [
  // --- direct children of ChargingStations -------------------------------
  {
    child: 'ChargingStationNetworkProfiles',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'cascade',
  },
  {
    child: 'ChargingStationSecurityInfos',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  {
    child: 'ChargingStationSequences',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'cascade',
  },
  { child: 'Connectors', column: 'stationPkId', parent: STATION_TABLE, onDelete: 'cascade' },
  {
    child: 'DeleteCertificateAttempts',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  { child: 'EventData', column: 'stationPkId', parent: STATION_TABLE, onDelete: 'set null' },
  { child: 'Evses', column: 'stationPkId', parent: STATION_TABLE, onDelete: 'cascade' },
  {
    child: 'InstallCertificateAttempts',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  {
    child: 'InstalledCertificates',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'cascade',
  },
  {
    child: 'LatestStatusNotifications',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  { child: 'OCPPMessages', column: 'stationPkId', parent: STATION_TABLE, onDelete: 'set null' },
  {
    child: 'SetNetworkProfiles',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  {
    child: 'StatusNotifications',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },
  { child: 'Transactions', column: 'stationPkId', parent: STATION_TABLE, onDelete: 'set null' },
  {
    child: 'VariableAttributes',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'cascade',
  },
  {
    child: 'VariableMonitorings',
    column: 'stationPkId',
    parent: STATION_TABLE,
    onDelete: 'set null',
  },

  // --- edges between the station's own rows -------------------------------
  {
    child: 'ChargingNeeds',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'no action',
  },
  { child: 'ChargingNeeds', column: 'evseId', parent: 'Evses', onDelete: 'set null' },
  {
    child: 'ChargingProfiles',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'set null',
  },
  {
    child: 'ChargingSchedules',
    column: 'chargingProfileDatabaseId',
    parent: 'ChargingProfiles',
    onDelete: 'cascade',
  },
  {
    child: 'ChargingStationNetworkProfiles',
    column: 'setNetworkProfileId',
    parent: 'SetNetworkProfiles',
    onDelete: 'cascade',
  },
  { child: 'Connectors', column: 'evseId', parent: 'Evses', onDelete: 'set null' },
  {
    child: 'LatestStatusNotifications',
    column: 'statusNotificationId',
    parent: 'StatusNotifications',
    onDelete: 'set null',
  },
  {
    child: 'LocalListVersionAuthorizations',
    column: 'localListVersionId',
    parent: 'LocalListVersions',
    onDelete: 'cascade',
  },
  {
    child: 'MeterValues',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'cascade',
  },
  {
    child: 'MeterValues',
    column: 'transactionEventId',
    parent: 'TransactionEvents',
    onDelete: 'cascade',
  },
  {
    child: 'MeterValues',
    column: 'stopTransactionDatabaseId',
    parent: 'StopTransactions',
    onDelete: 'cascade',
  },
  // Self-reference: one DELETE removes both ends, so it constrains nothing.
  {
    child: 'OCPPMessages',
    column: 'requestMessageId',
    parent: 'OCPPMessages',
    onDelete: 'set null',
  },
  {
    child: 'SalesTariffs',
    column: 'chargingScheduleDatabaseId',
    parent: 'ChargingSchedules',
    onDelete: 'cascade',
  },
  {
    child: 'SendLocalListAuthorizations',
    column: 'sendLocalListId',
    parent: 'SendLocalLists',
    onDelete: 'cascade',
  },
  {
    child: 'StartTransactions',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'cascade',
  },
  {
    child: 'StartTransactions',
    column: 'connectorDatabaseId',
    parent: 'Connectors',
    onDelete: 'set null',
  },
  {
    child: 'StopTransactions',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'cascade',
  },
  {
    child: 'TransactionEvents',
    column: 'transactionDatabaseId',
    parent: 'Transactions',
    onDelete: 'set null',
  },
  { child: 'Transactions', column: 'connectorId', parent: 'Connectors', onDelete: 'set null' },
  { child: 'Transactions', column: 'evseId', parent: 'Evses', onDelete: 'set null' },
  { child: 'VariableAttributes', column: 'bootConfigId', parent: 'Boots', onDelete: 'set null' },
  {
    child: 'VariableMonitoringStatuses',
    column: 'variableMonitoringId',
    parent: 'VariableMonitorings',
    onDelete: 'no action',
  },
  {
    child: 'VariableStatuses',
    column: 'variableAttributeId',
    parent: 'VariableAttributes',
    onDelete: 'cascade',
  },
];

/**
 * The order rows are removed in. Child strictly before parent, station last.
 *
 * The grouping is descriptive only — `validateDeletionOrder` is what actually
 * holds the order to the FK graph, so a future table can be slotted in wherever
 * the invariants allow.
 */
export const STATION_DELETION_ORDER: DeletionStep[] = [
  // 1. Grandchildren: no station column of their own, only reachable through a
  //    parent below. Two of these (ChargingNeeds, VariableMonitoringStatuses)
  //    are `no action` and would abort the whole delete if left for later.
  {
    table: 'MeterValues',
    where: [
      viaParent('transactionDatabaseId', 'Transactions', 'id'),
      viaParent('transactionEventId', 'TransactionEvents', 'id'),
      viaParent('stopTransactionDatabaseId', 'StopTransactions', 'id'),
    ].join(' OR '),
  },
  {
    table: 'VariableStatuses',
    where: viaParent('variableAttributeId', 'VariableAttributes', 'id'),
  },
  {
    table: 'VariableMonitoringStatuses',
    where: viaParent('variableMonitoringId', 'VariableMonitorings', 'databaseId'),
  },
  {
    table: 'SalesTariffs',
    where: viaParent('chargingScheduleDatabaseId', 'ChargingSchedules', 'databaseId'),
  },
  {
    table: 'ChargingNeeds',
    where: [
      viaParent('transactionDatabaseId', 'Transactions', 'id'),
      viaParent('evseId', 'Evses', 'id'),
    ].join(' OR '),
  },
  {
    table: 'LocalListVersionAuthorizations',
    where: viaParent('localListVersionId', 'LocalListVersions', 'id'),
  },
  {
    table: 'SendLocalListAuthorizations',
    where: viaParent('sendLocalListId', 'SendLocalLists', 'id'),
  },

  // 2. Station rows that point at other station rows. Charging history unwinds
  //    from the leaves (meter values, start/stop) back to Transactions, then
  //    the hardware rows Transactions point at (Connectors, then Evses).
  { table: 'LatestStatusNotifications', where: byStationId },
  { table: 'ChargingStationNetworkProfiles', where: byStationId },
  { table: 'ChargingSchedules', where: byStationId },
  { table: 'StartTransactions', where: byStationId },
  { table: 'StopTransactions', where: byStationId },
  { table: 'TransactionEvents', where: byStationId },
  { table: 'ChargingProfiles', where: byStationId },
  { table: 'Transactions', where: byStationId },
  { table: 'Connectors', where: byStationId },

  // 3. Everything else the station owns. Order inside this block is free —
  //    nothing here references anything else here, except VariableAttributes,
  //    which must precede Boots.
  { table: 'Evses', where: byStationId },
  { table: 'StatusNotifications', where: byStationId },
  { table: 'SetNetworkProfiles', where: byStationId },
  { table: 'VariableAttributes', where: byStationId },
  { table: 'VariableMonitorings', where: byStationId },
  { table: 'EventData', where: byStationId },
  { table: 'OCPPMessages', where: byStationId },
  { table: 'InstalledCertificates', where: byStationId },
  { table: 'InstallCertificateAttempts', where: byStationId },
  { table: 'DeleteCertificateAttempts', where: byStationId },
  { table: 'ChargingStationSecurityInfos', where: byStationId },
  { table: 'ChargingStationSequences', where: byStationId },
  { table: 'ChangeConfigurations', where: byStationId },
  { table: 'CompositeSchedules', where: byStationId },
  { table: 'Reservations', where: byStationId },
  { table: 'MessageInfos', where: byStationId },
  { table: 'SecurityEvents', where: byStationId },
  { table: 'Subscriptions', where: byStationId },
  { table: 'LocalListVersions', where: byStationId },
  { table: 'SendLocalLists', where: byStationId },
  // Our fork's table: RFID scopes must not survive into the next owner's hands.
  { table: 'StationAuthorizations', where: byStationId },
  // Boots is keyed by the station id itself, not a stationId column.
  { table: 'Boots', where: '"id" = :stationId AND "tenantId" = :tenantId' },

  // 4. The station. Only reachable once every referencing row above is gone,
  //    because the trigger turns `ON DELETE SET NULL` into an exception.
  { table: STATION_TABLE, where: '"id" = :stationId AND "tenantId" = :tenantId' },
];

/**
 * Check the order against the FK graph. Returns one message per violation, so
 * an empty array means "safe to run". This is the guard the unit test asserts
 * on: reorder two lines and it names exactly which edge broke.
 */
export function validateDeletionOrder(
  order: DeletionStep[] = STATION_DELETION_ORDER,
  edges: ForeignKeyEdge[] = STATION_FOREIGN_KEYS,
): string[] {
  const position = new Map<string, number>();
  order.forEach((step, index) => position.set(step.table, index));

  const violations: string[] = [];
  for (const edge of edges) {
    // A self-reference is cleared by its own DELETE.
    if (edge.child === edge.parent) {
      continue;
    }
    const childAt = position.get(edge.child);
    const parentAt = position.get(edge.parent);
    if (childAt === undefined || parentAt === undefined) {
      // Reported by missingTables(); not an ordering problem.
      continue;
    }
    if (childAt > parentAt) {
      violations.push(
        `${edge.child}.${edge.column} -> ${edge.parent} (${edge.onDelete}): child deleted at step ${childAt} but parent at ${parentAt}`,
      );
    }
  }
  return violations;
}

/**
 * Tables that appear in the FK graph but not in the plan. Any name here is a
 * table whose rows would block or outlive the delete — the failure mode when
 * an upstream CitrineOS release adds a child table and we do not notice.
 */
export function missingTables(
  order: DeletionStep[] = STATION_DELETION_ORDER,
  edges: ForeignKeyEdge[] = STATION_FOREIGN_KEYS,
): string[] {
  const planned = new Set(order.map((step) => step.table));
  const missing = new Set<string>();
  for (const edge of edges) {
    if (!planned.has(edge.child)) {
      missing.add(edge.child);
    }
    if (!planned.has(edge.parent)) {
      missing.add(edge.parent);
    }
  }
  return [...missing].sort();
}

/**
 * One statement per step. The DELETE is wrapped in a CTE so Postgres hands back
 * an exact row count regardless of what the driver puts in its metadata — the
 * caller needs the number to report what it erased.
 */
export function deletionStatement(step: DeletionStep): string {
  return `WITH deleted AS (DELETE FROM "${step.table}" WHERE ${step.where} RETURNING 1) SELECT count(*)::int AS count FROM deleted`;
}

/** Rows a caller must not destroy by accident — the charging history check. */
export const TRANSACTION_COUNT_SQL = `SELECT count(*)::int AS count FROM "Transactions" WHERE ${byStationId}`;
