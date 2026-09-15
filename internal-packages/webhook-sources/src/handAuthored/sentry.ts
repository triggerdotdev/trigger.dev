import { type SampleRecord } from "../sampleRecord.js";

/**
 * Sentry Integration Platform webhook samples. The resource type (issue/error) travels in the
 * `Sentry-Hook-Resource` header, not the body, so `eventType` here is the synthetic
 * `<resource>.<action>` string and each sample carries a matching `extraHeaders["sentry-hook-resource"]`
 * so the type survives loading. No preset applies (Sentry's signature scheme is bespoke), so no
 * `presetId` is set.
 */
export const samples: SampleRecord[] = [
  {
    provider: "sentry",
    providerLabel: "Sentry",
    eventType: "issue.created",
    name: "Issue created",
    description: "A new issue was created from an ingested error event.",
    body: {
      action: "created",
      installation: {
        uuid: "24b397fc-a86e-43ef-9297-949e21b82480",
      },
      data: {
        issue: {
          id: "4509877862268928",
          url: "https://sentry.io/api/0/organizations/acme-co/issues/4509877862268928/",
          web_url: "https://acme-co.sentry.io/issues/4509877862268928/",
          project_url: "https://acme-co.sentry.io/issues/?project=4509866123456789",
          shortId: "NODE-API-7",
          title: "TypeError: Cannot read properties of undefined (reading 'id')",
          culprit: "processOrder(app/services/orders.ts)",
          permalink: "https://acme-co.sentry.io/issues/4509877862268928/",
          logger: null,
          level: "error",
          status: "unresolved",
          substatus: "new",
          statusDetails: {},
          issueType: "error",
          issueCategory: "error",
          priority: "high",
          count: "1",
          userCount: 1,
          firstSeen: "2026-07-14T18:56:00.679000+00:00",
          lastSeen: "2026-07-14T18:56:00.738000+00:00",
          project: {
            id: "4509866123456789",
            name: "node-api",
            slug: "node-api",
            platform: "node",
          },
        },
      },
      actor: {
        type: "application",
        id: "sentry",
        name: "Sentry",
      },
    },
    extraHeaders: {
      "sentry-hook-resource": "issue.created",
    },
    docsUrl: "https://docs.sentry.io/product/integrations/integration-platform/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sentry",
    providerLabel: "Sentry",
    eventType: "issue.resolved",
    name: "Issue resolved",
    description: "A team member resolved an issue from the Sentry UI.",
    body: {
      action: "resolved",
      installation: {
        uuid: "24b397fc-a86e-43ef-9297-949e21b82480",
      },
      data: {
        issue: {
          id: "4509877862268928",
          url: "https://sentry.io/api/0/organizations/acme-co/issues/4509877862268928/",
          web_url: "https://acme-co.sentry.io/issues/4509877862268928/",
          project_url: "https://acme-co.sentry.io/issues/?project=4509866123456789",
          shortId: "NODE-API-7",
          title: "TypeError: Cannot read properties of undefined (reading 'id')",
          culprit: "processOrder(app/services/orders.ts)",
          permalink: "https://acme-co.sentry.io/issues/4509877862268928/",
          logger: null,
          level: "error",
          status: "resolved",
          substatus: null,
          statusDetails: {
            inNextRelease: true,
          },
          issueType: "error",
          issueCategory: "error",
          priority: "high",
          count: "14",
          userCount: 6,
          firstSeen: "2026-07-12T09:12:44.201000+00:00",
          lastSeen: "2026-07-14T18:56:00.738000+00:00",
          project: {
            id: "4509866123456789",
            name: "node-api",
            slug: "node-api",
            platform: "node",
          },
        },
      },
      actor: {
        type: "user",
        id: "56789",
        name: "Morgan Reyes",
        email: "morgan@example.com",
      },
    },
    extraHeaders: {
      "sentry-hook-resource": "issue.resolved",
    },
    docsUrl: "https://docs.sentry.io/product/integrations/integration-platform/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sentry",
    providerLabel: "Sentry",
    eventType: "issue.assigned",
    name: "Issue assigned",
    description: "An issue was assigned to a team member.",
    body: {
      action: "assigned",
      installation: {
        uuid: "24b397fc-a86e-43ef-9297-949e21b82480",
      },
      data: {
        issue: {
          id: "4509877862299001",
          url: "https://sentry.io/api/0/organizations/acme-co/issues/4509877862299001/",
          web_url: "https://acme-co.sentry.io/issues/4509877862299001/",
          project_url: "https://acme-co.sentry.io/issues/?project=4509866123456789",
          shortId: "NODE-API-11",
          title: "Timeout connecting to redis://cache-primary:6379",
          culprit: "RedisClient.connect(app/lib/cache.ts)",
          permalink: "https://acme-co.sentry.io/issues/4509877862299001/",
          logger: null,
          level: "warning",
          status: "unresolved",
          substatus: "ongoing",
          statusDetails: {},
          issueType: "error",
          issueCategory: "error",
          priority: "medium",
          count: "42",
          userCount: 9,
          firstSeen: "2026-07-10T03:41:19.442000+00:00",
          lastSeen: "2026-07-14T17:03:52.114000+00:00",
          project: {
            id: "4509866123456789",
            name: "node-api",
            slug: "node-api",
            platform: "node",
          },
        },
        assignee: {
          type: "user",
          id: "56789",
          name: "Morgan Reyes",
          email: "morgan@example.com",
        },
      },
      actor: {
        type: "user",
        id: "56789",
        name: "Morgan Reyes",
        email: "morgan@example.com",
      },
    },
    extraHeaders: {
      "sentry-hook-resource": "issue.assigned",
    },
    docsUrl: "https://docs.sentry.io/product/integrations/integration-platform/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sentry",
    providerLabel: "Sentry",
    eventType: "error.created",
    name: "Error event created",
    description: "A new error event was ingested and matched to an issue.",
    body: {
      action: "created",
      installation: {
        uuid: "24b397fc-a86e-43ef-9297-949e21b82480",
      },
      data: {
        error: {
          event_id: "f2f4b3c8e1a94d6f9b3d2c7a5e8f1b40",
          issue_id: "4509877862268928",
          url: "https://sentry.io/api/0/projects/acme-co/node-api/events/f2f4b3c8e1a94d6f9b3d2c7a5e8f1b40/",
          web_url:
            "https://acme-co.sentry.io/issues/4509877862268928/events/f2f4b3c8e1a94d6f9b3d2c7a5e8f1b40/",
          issue_url: "https://sentry.io/api/0/organizations/acme-co/issues/4509877862268928/",
          project: "node-api",
          type: "error",
          title: "TypeError: Cannot read properties of undefined (reading 'id')",
          message: "Cannot read properties of undefined (reading 'id')",
          level: "error",
          culprit: "processOrder(app/services/orders.ts)",
          platform: "node",
          sdk: {
            name: "sentry.javascript.node",
            version: "8.42.0",
          },
          exception: {
            values: [
              {
                type: "TypeError",
                value: "Cannot read properties of undefined (reading 'id')",
                mechanism: { type: "onunhandledrejection", handled: false },
                stacktrace: {
                  frames: [
                    {
                      filename: "app/services/orders.ts",
                      function: "processOrder",
                      lineno: 42,
                      colno: 18,
                      in_app: true,
                    },
                  ],
                },
              },
            ],
          },
          contexts: {
            os: { name: "Linux", version: "6.2.0" },
            runtime: { name: "node", version: "20.14.0" },
          },
          tags: [
            ["environment", "production"],
            ["level", "error"],
            ["release", "node-api@2026.7.3"],
          ],
          user: {
            id: "38214",
            email: "customer@example.com",
          },
          datetime: "2026-07-14T18:56:00.679000Z",
          timestamp: 1786820160.679,
          received: 1786820160.812,
        },
      },
      actor: {
        type: "application",
        id: "sentry",
        name: "Sentry",
      },
    },
    extraHeaders: {
      "sentry-hook-resource": "error.created",
    },
    docsUrl: "https://docs.sentry.io/product/integrations/integration-platform/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
