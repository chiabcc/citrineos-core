// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { TenantDto } from '@citrineos/base';
import { DEFAULT_TENANT_ID } from '@citrineos/base';
import {
  BeforeCreate,
  BeforeUpdate,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
// Import the Authorization/Tenant models by their concrete files (not the DAL barrel)
// to avoid an import cycle: the DAL barrel pulls in DefaultSequelizeInstance, which in
// turn registers this model.
import { Authorization } from '@dal/layers/sequelize/model/Authorization/Authorization.js';
import { Tenant } from '@dal/layers/sequelize/model/Tenant.js';

/**
 * StationAuthorizations — additive join table owned by the Provisioning module.
 *
 * Scopes an idToken (Authorization) to one or more charging stations.
 * - No row for an authorization = global tag (backward compatible: usable anywhere).
 * - One or more rows = tag is only valid at the listed stationIds.
 *
 * Enforced at runtime by {@link StationScopeAuthorizer}. This table is never read
 * by upstream CitrineOS code, so no core model is modified.
 */
@Table({ tableName: 'StationAuthorizations' })
export class StationAuthorization extends Model {
  static readonly MODEL_NAME: string = 'StationAuthorization';

  @ForeignKey(() => Authorization)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    unique: 'authorizationId_stationId',
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  })
  declare authorizationId: number;

  @BelongsTo(() => Authorization, { foreignKey: 'authorizationId', onDelete: 'CASCADE' })
  declare authorization?: Authorization;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    unique: 'authorizationId_stationId',
  })
  declare stationId: string;

  @ForeignKey(() => Tenant)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  })
  declare tenantId: number;

  @BelongsTo(() => Tenant, 'tenantId')
  declare tenant?: TenantDto;

  @BeforeUpdate
  @BeforeCreate
  static setDefaultTenant(instance: StationAuthorization) {
    if (instance.tenantId == null) {
      instance.tenantId = DEFAULT_TENANT_ID;
    }
  }

  constructor(...args: any[]) {
    super(...args);
    if (this.tenantId == null) {
      this.tenantId = DEFAULT_TENANT_ID;
    }
  }
}
