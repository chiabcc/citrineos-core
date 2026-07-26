// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Pure topology planning — deliberately free of imports so it can be unit
// tested without the rest of the server.

export interface CreateEvseInput {
  evseNo: number;
  connectors: CreateConnectorInput[];
}

export interface CreateConnectorInput {
  type?: string;
  powerType?: string;
  maxPowerW?: number;
}

/**
 * Work out every row a station's topology needs, before touching the database.
 *
 * Kept separate because the numbering is the part that is easy to get wrong and
 * costly when it is: `connectorId` is unique across the WHOLE station (how OCPP
 * 1.6 addresses a connector) while `evseTypeConnectorId` restarts at 1 inside
 * each EVSE (how 2.0.1 does). An earlier version assumed one EVSE per connector,
 * which described a DC unit with CCS2 + CHAdeMO on a single supply point as two
 * EVSEs — telling the CSMS it could serve two cars at once.
 */
export function planTopology(input: {
  evses?: CreateEvseInput[];
  connectorCount?: number;
}): {
  evseNo: number;
  connectorId: number;
  evseConnectorId: number;
  connector: CreateConnectorInput;
}[] {
  const topology: CreateEvseInput[] =
    input.evses && input.evses.length > 0
      ? input.evses
      : Array.from({ length: input.connectorCount ?? 1 }, (_, i) => ({
          evseNo: i + 1,
          connectors: [{}],
        }));

  const rows: {
    evseNo: number;
    connectorId: number;
    evseConnectorId: number;
    connector: CreateConnectorInput;
  }[] = [];
  let connectorId = 0;
  for (const evse of topology) {
    for (const [j, connector] of evse.connectors.entries()) {
      connectorId += 1;
      rows.push({ evseNo: evse.evseNo, connectorId, evseConnectorId: j + 1, connector });
    }
  }
  return rows;
}

