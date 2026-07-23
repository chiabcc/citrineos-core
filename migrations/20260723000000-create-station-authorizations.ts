// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

import { DEFAULT_TENANT_ID } from '@citrineos/base';
import { DataTypes, QueryInterface } from 'sequelize';

/**
 * Creates the StationAuthorizations join table (Provisioning module, ADR: local-start-policy).
 *
 * Scopes an idToken (Authorization) to specific charging stations. No row for an
 * authorization means the tag is global (backward compatible). Additive only — no
 * existing table is altered.
 */
export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable('StationAuthorizations', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      authorizationId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Authorizations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      stationId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Tenants',
          key: 'id',
        },
        defaultValue: DEFAULT_TENANT_ID,
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addConstraint('StationAuthorizations', {
      fields: ['authorizationId', 'stationId'],
      type: 'unique',
      name: 'StationAuthorizations_authorizationId_stationId_uk',
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable('StationAuthorizations');
  },
};
