// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  deletionStatement,
  missingTables,
  STATION_DELETION_ORDER,
  STATION_FOREIGN_KEYS,
  STATION_TABLE,
  validateDeletionOrder,
  type DeletionStep,
} from '../../src/module/station-deletion';

// Deleting a station is the one write in this module that cannot be undone, and
// the order the tables go in is invisible until it is too late: a wrong order
// either aborts the transaction (loud, survivable) or leaves orphan rows behind
// that keep the station id unusable — which is the exact problem the endpoint
// exists to solve. So the order is data, and this file is the thing that holds
// it to the foreign keys it was derived from.

const at = (table: string) => STATION_DELETION_ORDER.findIndex((s) => s.table === table);
const before = (child: string, parent: string) => {
  expect(at(child), `${child} missing from the plan`).toBeGreaterThanOrEqual(0);
  expect(at(parent), `${parent} missing from the plan`).toBeGreaterThanOrEqual(0);
  expect(at(child), `${child} must be deleted before ${parent}`).toBeLessThan(at(parent));
};

describe('station deletion order', () => {
  it('satisfies every foreign key it was derived from', () => {
    expect(validateDeletionOrder()).toEqual([]);
  });

  it('covers every table named in the foreign key graph', () => {
    expect(missingTables()).toEqual([]);
  });

  it('deletes the station itself last — the trigger makes it unreachable before that', () => {
    expect(STATION_DELETION_ORDER.at(-1)?.table).toBe(STATION_TABLE);
    expect(STATION_DELETION_ORDER.filter((s) => s.table === STATION_TABLE)).toHaveLength(1);
  });

  it('lists each table exactly once — a repeat means a merge went wrong', () => {
    const tables = STATION_DELETION_ORDER.map((s) => s.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  // The two edges that abort outright. Everything else fails quietly; these
  // fail with a foreign key violation and roll the whole delete back.
  it('clears the NO ACTION children before their parents', () => {
    before('ChargingNeeds', 'Transactions');
    before('VariableMonitoringStatuses', 'VariableMonitorings');
  });

  it('unwinds charging history from the leaves back to Transactions', () => {
    before('MeterValues', 'TransactionEvents');
    before('MeterValues', 'StopTransactions');
    before('MeterValues', 'Transactions');
    before('StartTransactions', 'Transactions');
    before('StopTransactions', 'Transactions');
    before('TransactionEvents', 'Transactions');
  });

  // Transactions and StartTransactions point at the hardware rows, and
  // Connectors point at Evses — so the hardware unwinds outside-in.
  it('drops the hardware rows after everything pointing at them', () => {
    before('Transactions', 'Connectors');
    before('Transactions', 'Evses');
    before('StartTransactions', 'Connectors');
    before('Connectors', 'Evses');
    before('ChargingNeeds', 'Evses');
  });

  it('drops the remaining station-owned parents after their dependants', () => {
    before('VariableStatuses', 'VariableAttributes');
    before('SalesTariffs', 'ChargingSchedules');
    before('ChargingSchedules', 'ChargingProfiles');
    before('LatestStatusNotifications', 'StatusNotifications');
    before('ChargingStationNetworkProfiles', 'SetNetworkProfiles');
    before('LocalListVersionAuthorizations', 'LocalListVersions');
    before('SendLocalListAuthorizations', 'SendLocalLists');
    // Boot config is referenced by VariableAttributes, not the other way round.
    before('VariableAttributes', 'Boots');
  });

  it('includes all sixteen direct children of ChargingStations', () => {
    const direct = STATION_FOREIGN_KEYS.filter((e) => e.parent === STATION_TABLE);
    expect(direct).toHaveLength(16);
    for (const edge of direct) {
      before(edge.child, STATION_TABLE);
    }
  });

  // A station id that stays unusable is the bug this endpoint was written to
  // fix, so the fork's own scope table has to go with the station.
  it('takes the fork-added StationAuthorizations with it', () => {
    before('StationAuthorizations', STATION_TABLE);
  });
});

describe('deletion statements', () => {
  // The nightmare is a step whose predicate forgets the station and truncates a
  // table for every tenant on the platform. Nothing may run unscoped.
  it('scopes every statement to one station and one tenant', () => {
    for (const step of STATION_DELETION_ORDER) {
      expect(step.where, `${step.table} is not scoped by station`).toContain(':stationId');
      expect(step.where, `${step.table} is not scoped by tenant`).toContain(':tenantId');
    }
  });

  it('binds parameters instead of interpolating them', () => {
    const sql = deletionStatement({ table: 'Connectors', where: '"stationId" = :stationId' });
    expect(sql).toBe(
      'WITH deleted AS (DELETE FROM "Connectors" WHERE "stationId" = :stationId RETURNING 1) SELECT count(*)::int AS count FROM deleted',
    );
  });

  it('asks Postgres for the row count rather than trusting driver metadata', () => {
    for (const step of STATION_DELETION_ORDER) {
      expect(deletionStatement(step)).toMatch(/RETURNING 1\) SELECT count\(\*\)::int AS count/);
    }
  });
});

describe('validateDeletionOrder', () => {
  const edges = [
    { child: 'B', column: 'aId', parent: 'A', onDelete: 'no action' as const },
    { child: 'C', column: 'bId', parent: 'B', onDelete: 'cascade' as const },
  ];
  const step = (table: string): DeletionStep => ({ table, where: 'true' });

  it('passes a correctly ordered plan', () => {
    expect(validateDeletionOrder([step('C'), step('B'), step('A')], edges)).toEqual([]);
  });

  it('names the edge when a parent is deleted before its child', () => {
    const violations = validateDeletionOrder([step('A'), step('B'), step('C')], edges);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('B.aId -> A');
  });

  it('ignores self-references — one DELETE removes both ends', () => {
    const selfEdge = [
      { child: 'A', column: 'parentId', parent: 'A', onDelete: 'set null' as const },
    ];
    expect(validateDeletionOrder([step('A')], selfEdge)).toEqual([]);
  });

  it('reports an unplanned table as missing rather than as an ordering fault', () => {
    expect(validateDeletionOrder([step('C'), step('B')], edges)).toEqual([]);
    expect(missingTables([step('C'), step('B')], edges)).toEqual(['A']);
  });
});
