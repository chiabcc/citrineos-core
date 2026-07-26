// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { planTopology } from '../../src/module/topology';

// OCPP 1.6 and 2.0.1 number connectors by different rules, and the same integer
// means different things in each. Getting it wrong is silent: the rows are
// created, they just describe a station that does not exist.
//
//   connectorId          unique across the WHOLE station   (1.6 addresses this)
//   evseTypeConnectorId  restarts at 1 inside each EVSE    (2.0.1 addresses this)

const shape = (rows: ReturnType<typeof planTopology>) =>
  rows.map((r) => `${r.evseNo}/${r.connectorId}/${r.evseConnectorId}`);

describe('planTopology', () => {
  it('plans a home box: one EVSE, one head', () => {
    expect(shape(planTopology({ evses: [{ evseNo: 1, connectors: [{}] }] }))).toEqual(['1/1/1']);
  });

  // The case the previous implementation got wrong. A DC unit with CCS2 and
  // CHAdeMO on one supply point serves ONE car; describing it as two EVSEs told
  // the CSMS it could serve two.
  it('keeps two heads on a single EVSE instead of splitting them', () => {
    const rows = planTopology({ evses: [{ evseNo: 1, connectors: [{}, {}] }] });
    expect(shape(rows)).toEqual(['1/1/1', '1/2/2']);
    expect(new Set(rows.map((r) => r.evseNo)).size).toBe(1);
  });

  it('keeps connectorId running across EVSEs while the per-EVSE number restarts', () => {
    const rows = planTopology({
      evses: [
        { evseNo: 1, connectors: [{}, {}] },
        { evseNo: 2, connectors: [{}] },
      ],
    });
    expect(shape(rows)).toEqual(['1/1/1', '1/2/2', '2/3/1']);
  });

  it('carries each connector through untouched', () => {
    const rows = planTopology({
      evses: [
        {
          evseNo: 1,
          connectors: [
            { type: 'ccs2', powerType: 'dc', maxPowerW: 50000 },
            { type: 'chademo', powerType: 'dc', maxPowerW: 50000 },
          ],
        },
      ],
    });
    expect(rows.map((r) => r.connector.type)).toEqual(['ccs2', 'chademo']);
    expect(rows[1].connector.maxPowerW).toBe(50000);
  });

  // Older callers pass a bare count. It has always meant "N stations that can
  // each serve a car", so it stays one EVSE per connector.
  it('treats the connectorCount shorthand as N single-head EVSEs', () => {
    expect(shape(planTopology({ connectorCount: 3 }))).toEqual(['1/1/1', '2/2/1', '3/3/1']);
  });

  it('defaults to a single head when told nothing', () => {
    expect(shape(planTopology({}))).toEqual(['1/1/1']);
  });

  it('prefers an explicit topology over the shorthand', () => {
    const rows = planTopology({ evses: [{ evseNo: 1, connectors: [{}, {}] }], connectorCount: 8 });
    expect(shape(rows)).toEqual(['1/1/1', '1/2/2']);
  });
});
