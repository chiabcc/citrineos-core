// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_TENANT_ID,
  defineConfig,
  HUBJECT_DEFAULT_BASEURL,
  HUBJECT_DEFAULT_CLIENTID,
  HUBJECT_DEFAULT_CLIENTSECRET,
  HUBJECT_DEFAULT_TOKENURL,
  OCPP1_6,
  OCPP2_0_1,
  OCPP_CallAction,
  OCPP_VERSION_LIST,
} from '@citrineos/base';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

export function createDockerConfig() {
  return defineConfig({
    env: 'development',
    centralSystem: {
      host: '0.0.0.0',
      port: 8080,
    },
    modules: {
      certificates: {
        endpointPrefix: '/certificates',
        responses: [
          OCPP_CallAction.CertificateSigned,
          OCPP_CallAction.DeleteCertificate,
          OCPP_CallAction.GetInstalledCertificateIds,
          OCPP_CallAction.InstallCertificate,
        ],
        requests: [
          OCPP_CallAction.Get15118EVCertificate,
          OCPP_CallAction.GetCertificateStatus,
          OCPP_CallAction.SignCertificate,
        ],
      },
      configuration: {
        responses: [
          OCPP_CallAction.ChangeAvailability,
          OCPP_CallAction.ClearDisplayMessage,
          OCPP_CallAction.DataTransfer,
          OCPP_CallAction.GetDisplayMessages,
          OCPP_CallAction.PublishFirmware,
          OCPP_CallAction.Reset,
          OCPP_CallAction.SetDisplayMessage,
          OCPP_CallAction.SetNetworkProfile,
          OCPP_CallAction.TriggerMessage,
          OCPP_CallAction.UnpublishFirmware,
          OCPP_CallAction.UpdateFirmware,
          OCPP_CallAction.ChangeConfiguration,
          OCPP_CallAction.GetConfiguration,
        ],
        requests: [
          OCPP_CallAction.BootNotification,
          OCPP_CallAction.DataTransfer,
          OCPP_CallAction.FirmwareStatusNotification,
          OCPP_CallAction.Heartbeat,
          OCPP_CallAction.NotifyDisplayMessages,
          OCPP_CallAction.PublishFirmwareStatusNotification,
          // 1.6 signed-firmware progress. A module only receives the actions
          // listed here — a handler alone is not enough, and the station gets
          // no answer at all rather than an error.
          OCPP_CallAction.SignedFirmwareStatusNotification,
        ],
        heartbeatInterval: 60,
        bootRetryInterval: 15,
        ocpp2_0_1: {
          unknownChargerStatus: OCPP2_0_1.RegistrationStatusEnumType.Accepted,
          getBaseReportOnPending: true,
          bootWithRejectedVariables: true,
          autoAccept: true,
        },
        ocpp1_6: {
          unknownChargerStatus: OCPP1_6.BootNotificationResponseStatus.Accepted,
        },
        endpointPrefix: '/configuration',
      },
      evdriver: {
        endpointPrefix: '/evdriver',
        enableGetChargingProfilesOnStartTransaction: true,
        responses: [
          OCPP_CallAction.CancelReservation,
          OCPP_CallAction.ClearCache,
          OCPP_CallAction.GetLocalListVersion,
          OCPP_CallAction.RequestStartTransaction,
          OCPP_CallAction.RequestStopTransaction,
          OCPP_CallAction.ReserveNow,
          OCPP_CallAction.SendLocalList,
          OCPP_CallAction.UnlockConnector,
          OCPP_CallAction.RemoteStopTransaction,
          OCPP_CallAction.RemoteStartTransaction,
        ],
        requests: [
          OCPP_CallAction.Authorize,
          OCPP_CallAction.ReservationStatusUpdate,
          OCPP_CallAction.VatNumberValidation,
        ],
      },
      monitoring: {
        endpointPrefix: '/monitoring',
        responses: [
          OCPP_CallAction.ClearVariableMonitoring,
          OCPP_CallAction.GetVariables,
          OCPP_CallAction.SetMonitoringBase,
          OCPP_CallAction.SetMonitoringLevel,
          OCPP_CallAction.GetMonitoringReport,
          OCPP_CallAction.SetVariableMonitoring,
          OCPP_CallAction.SetVariables,
        ],
        requests: [OCPP_CallAction.NotifyEvent],
      },
      reporting: {
        endpointPrefix: '/reporting',
        responses: [
          OCPP_CallAction.CustomerInformation,
          OCPP_CallAction.GetLog,
          OCPP_CallAction.GetReport,
          OCPP_CallAction.GetBaseReport,
          OCPP_CallAction.GetMonitoringReport,
        ],
        requests: [
          OCPP_CallAction.LogStatusNotification,
          OCPP_CallAction.NotifyCustomerInformation,
          OCPP_CallAction.NotifyReport,
          OCPP_CallAction.SecurityEventNotification,
          OCPP_CallAction.NotifyMonitoringReport,
        ],
      },
      smartcharging: {
        endpointPrefix: '/smartcharging',
        responses: [
          OCPP_CallAction.ClearChargingProfile,
          OCPP_CallAction.GetChargingProfiles,
          OCPP_CallAction.GetCompositeSchedule,
          OCPP_CallAction.SetChargingProfile,
        ],
        requests: [
          OCPP_CallAction.ClearedChargingLimit,
          OCPP_CallAction.NotifyChargingLimit,
          OCPP_CallAction.NotifyEVChargingNeeds,
          OCPP_CallAction.NotifyEVChargingSchedule,
          OCPP_CallAction.ReportChargingProfiles,
        ],
      },
      tenant: {
        endpointPrefix: '/tenant',
        responses: [],
        requests: [],
      },
      provisioning: {
        endpointPrefix: 'provisioning',
        responses: [],
        requests: [],
      },
      transactions: {
        endpointPrefix: '/transactions',
        costUpdatedInterval: 60,
        responses: [
          OCPP_CallAction.CostUpdated,
          OCPP_CallAction.GetTransactionStatus,
          OCPP_CallAction.SetDefaultTariff,
        ],
        requests: [
          OCPP_CallAction.MeterValues,
          OCPP_CallAction.StatusNotification,
          OCPP_CallAction.TransactionEvent,
          OCPP_CallAction.StatusNotification,
          OCPP_CallAction.StartTransaction,
          OCPP_CallAction.StopTransaction,
          OCPP_CallAction.NotifySettlement,
        ],
      },
    },
    util: {
      cache: {
        memory: true,
      },
      messageBroker: {
        amqp: {
          url: 'amqp://guest:guest@amqp-broker:5672',
          exchange: 'citrineos',
        },
      },
      authProvider: {
        localByPass: true,
      },
      swagger: {
        path: '/docs',
        logoPath: path.resolve(path.dirname(__filename), '../../assets/logo.png'),
        exposeData: true,
        exposeMessage: true,
      },
      networkConnection: {
        websocketServers: [
          // No securityProfile 0 listener. Upstream ships one on 8081, where
          // CitrineOS discards the Authorization header outright: any station
          // already provisioned connects with no credentials at all, so the
          // password the wizard hands an owner decides nothing. It also made
          // every test run on it prove less than it appeared to — the bug that
          // stopped real chargers authenticating (ADR 024) survived weeks of
          // green suites for exactly that reason.
          //
          // Provision-first stays on every remaining port (ADR 010). Registering
          // an unknown station creates a row with NO topology, which then fails
          // every StatusNotification it sends (Connector.evseId cannot be null),
          // and this fork's populate_station_pk_id trigger already makes the
          // first BootNotification of an unknown station throw — so
          // auto-registration never worked here anyway.
          {
            id: '1',
            securityProfile: 1,
            allowUnknownChargingStations: false,
            pingInterval: 60,
            host: '0.0.0.0',
            port: 8082,
            protocols: OCPP_VERSION_LIST,
            tenantId: DEFAULT_TENANT_ID,
            dynamicTenantResolution: false,
          },
          {
            id: '2',
            securityProfile: 2,
            allowUnknownChargingStations: false,
            pingInterval: 60,
            host: '0.0.0.0',
            port: 8443,
            protocols: OCPP_VERSION_LIST,
            tlsKeyFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/leafKey.pem',
            ),
            tlsCertificateChainFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/certChain.pem',
            ),
            rootCACertificateFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/rootCertificate.pem',
            ),
            tenantId: DEFAULT_TENANT_ID,
            dynamicTenantResolution: false,
          },
          {
            id: '3',
            securityProfile: 3,
            allowUnknownChargingStations: false,
            pingInterval: 60,
            host: '0.0.0.0',
            port: 8444,
            protocols: OCPP_VERSION_LIST,
            tlsKeyFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/leafKey.pem',
            ),
            tlsCertificateChainFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/certChain.pem',
            ),
            mtlsCertificateAuthorityKeyFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/subCAKey.pem',
            ),
            rootCACertificateFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/rootCertificate.pem',
            ),
            tenantId: DEFAULT_TENANT_ID,
            dynamicTenantResolution: false,
          },
        ],
      },
      certificateAuthority: {
        v2gCA: {
          name: 'hubject',
          hubject: {
            baseUrl: HUBJECT_DEFAULT_BASEURL,
            tokenUrl: HUBJECT_DEFAULT_TOKENURL,
            clientId: HUBJECT_DEFAULT_CLIENTID,
            clientSecret: HUBJECT_DEFAULT_CLIENTSECRET,
          },
        },
        chargingStationCA: {
          name: 'acme',
          acme: {
            env: 'staging',
            accountKeyFilePath: path.resolve(
              path.dirname(__filename),
              '../../assets/certificates/acme_account_key.pem',
            ),
            email: 'test@citrineos.com',
          },
        },
      },
    },
    logLevel: 2, // debug
    maxCallLengthSeconds: 20,
    maxCachingSeconds: 30,
    ocpiServer: {
      host: '0.0.0.0',
      port: 8085,
    },
    userPreferences: {
      // None by default
    },
  });
}
