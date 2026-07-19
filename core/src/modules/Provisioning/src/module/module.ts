// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type {
  BootstrapConfig,
  CallAction,
  ICache,
  IMessageHandler,
  IMessageSender,
  SystemConfig,
} from '@citrineos/base';
import { AbstractModule, EventGroup, OCPPValidator } from '@citrineos/base';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

/**
 * Provisioning module — REST data endpoints for pre-registering charging
 * stations with their EVSE/connector topology before the charger connects.
 *
 * OCPP 1.6 chargers cannot report their own device model, so the topology
 * must exist ahead of the first StatusNotification. This module owns that
 * write path so API consumers never touch the database directly.
 */
export class ProvisioningModule extends AbstractModule {
  _requests: CallAction[] = [];
  _responses: CallAction[] = [];

  constructor(
    config: BootstrapConfig & SystemConfig,
    cache: ICache,
    sender: IMessageSender,
    handler: IMessageHandler,
    logger?: Logger<ILogObj>,
    ocppValidator?: OCPPValidator,
  ) {
    super(config, cache, handler, sender, EventGroup.Provisioning, logger, ocppValidator);
    this._requests = config.modules.provisioning?.requests ?? [];
    this._responses = config.modules.provisioning?.responses ?? [];
  }
}
