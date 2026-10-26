import { type SampleRecord } from "../sampleRecord.js";

/**
 * Infisical samples (General webhook type). Infisical signs with its own `x-infisical-signature`
 * (`t=<ms>;<hex>`) HMAC-SHA256 scheme, which is not one of our presets, so no `presetId` is set.
 * `eventType` is the top-level `event` field, and every body ends with a top-level `timestamp` in
 * epoch milliseconds. Secret events nest scope under `project` (`secrets.modified` repeats the
 * project id as the legacy `workspaceId`); change and access request events add `action` and a
 * `request` object, with `project` reduced to `id` and `name`. Field order and the extra
 * `projectId`/`projectName` on `secrets.modified` follow `backend/src/services/webhook/webhook-fns.ts`,
 * which is a superset of the docs example.
 */
export const samples: SampleRecord[] = [
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "secrets.modified",
    name: "Secrets modified",
    description:
      "Secrets in the production environment's /backend folder were created, updated or deleted.",
    body: {
      event: "secrets.modified",
      project: {
        workspaceId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectName: "Payments Platform",
        environment: "prod",
        environmentName: "Production",
        secretPath: "/backend",
        changedBy: "lena@acme.dev",
        changedByActorType: "user",
      },
      timestamp: 1792050112408,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "secrets.rotation-failed",
    name: "Secret rotation failed",
    description: "A scheduled database credential rotation failed.",
    body: {
      event: "secrets.rotation-failed",
      project: {
        projectId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectName: "Payments Platform",
        environment: "prod",
        environmentName: "Production",
        secretPath: "/database",
        rotationName: "postgres-app-user",
        errorMessage: 'password authentication failed for user "rotator"',
        triggeredManually: false,
      },
      timestamp: 1792053600217,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "honey-token.triggered",
    name: "Honey token triggered",
    description: "Someone used a planted AWS honey token credential.",
    body: {
      event: "honey-token.triggered",
      project: {
        projectId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectName: "Payments Platform",
        environment: "prod",
        environmentName: "Production",
        secretPath: "/legacy",
      },
      honeyToken: {
        name: "legacy-ci-deploy-key",
        eventName: "GetCallerIdentity",
        sourceIp: "203.0.113.42",
        awsRegion: "us-east-1",
      },
      timestamp: 1792057331902,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "secrets.change-request.modified",
    name: "Change request merged",
    description: "A secret change request against production was approved and merged.",
    body: {
      event: "secrets.change-request.modified",
      action: "merged",
      project: {
        id: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        name: "Payments Platform",
      },
      request: {
        id: "8b3e5d71-2c9a-4f6e-a1d4-7e0c3b9f5a28",
        slug: "Vq9mT2xRk4",
        url: "https://app.infisical.com/organizations/3d7a1f5c-9e2b-4c8d-b6a0-5f4e2d1c9b73/projects/secret-management/6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96/approval?requestId=8b3e5d71-2c9a-4f6e-a1d4-7e0c3b9f5a28",
        target: {
          environment: {
            name: "Production",
            slug: "prod",
          },
          secretPath: "/backend",
        },
        status: "close",
        hasMerged: true,
        isBypassed: false,
        policy: {
          id: "c5a9e2f7-6b1d-4a3e-8f0c-9d2b4e7a1c65",
          name: "Production secrets",
          enforcementLevel: "hard",
        },
        requestedBy: {
          type: "user",
          id: "1e7c4a9b-3d6f-4b2e-9a5c-8f0d2e6b4a17",
          name: "Lena Brandt",
          email: "lena@acme.dev",
        },
        createdAt: "2026-10-15T13:05:21.000Z",
        updatedAt: "2026-10-15T13:48:09.000Z",
      },
      timestamp: 1792072089514,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "secrets.access-request.modified",
    name: "Access request reviewed",
    description: "A temporary access request for production secrets was approved.",
    body: {
      event: "secrets.access-request.modified",
      action: "reviewed",
      project: {
        id: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        name: "Payments Platform",
      },
      request: {
        id: "4d2f8a6c-1e9b-4c7a-b3d5-6a0e9f2c8b41",
        url: "https://app.infisical.com/organizations/3d7a1f5c-9e2b-4c8d-b6a0-5f4e2d1c9b73/projects/secret-management/6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96/approval?selectedTab=resource-requests&requestId=4d2f8a6c-1e9b-4c7a-b3d5-6a0e9f2c8b41",
        status: "approved",
        isBypassed: false,
        policy: {
          id: "a7e3c1b9-5d2f-4e8a-9b6c-0f4d8e2a7c13",
          name: "Production access",
          enforcementLevel: "soft",
          hasSequencedApprovers: false,
        },
        requestedAccess: {
          target: {
            environment: {
              name: "Production",
              slug: "prod",
            },
            secretPath: "/services/*",
          },
          isTemporary: true,
          temporaryRange: "4h",
          permissions: [{ subject: "secrets", actions: ["read"] }],
        },
        requestedBy: {
          type: "user",
          id: "9c5b2e8d-7a1f-4d3c-a6e9-2b8f0d4c7e52",
          name: "Tomas Reyes",
          email: "tomas@acme.dev",
        },
        expiresAt: "2026-10-15T19:20:40.000Z",
        approvedAt: "2026-10-15T15:20:40.000Z",
        revokedAt: null,
        createdAt: "2026-10-15T15:02:17.000Z",
        updatedAt: "2026-10-15T15:20:40.000Z",
      },
      timestamp: 1792077640733,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "infisical",
    providerLabel: "Infisical",
    eventType: "test",
    name: "Test event",
    description: "The test delivery sent from the webhook's Test button in project settings.",
    body: {
      event: "test",
      project: {
        workspaceId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectId: "6f1c2a9e-4b7d-4e3a-9c8f-2d5b7e1a4c96",
        projectName: "Payments Platform",
        environment: "prod",
        environmentName: "Production",
        secretPath: "/",
      },
      timestamp: 1792048200056,
    },
    docsUrl: "https://infisical.com/docs/documentation/platform/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
