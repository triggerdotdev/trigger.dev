import { type SampleRecord } from "../sampleRecord.js";

/**
 * Tailscale samples. Tailscale signs with a custom `Tailscale-Webhook-Signature` scheme (not one of our
 * presets), so no `presetId` is set. Every body is a JSON array of events, and one request can batch
 * several; each event has `timestamp` (RFC 3339 with offset), `version`, `type`, `tailnet`, `message`
 * and an optional `data` object (`null` for `test`). `eventType` is the `type` of the first event,
 * matching the registry's `0.type` path.
 */
export const samples: SampleRecord[] = [
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "test",
    name: "Test event",
    description: "The test event sent from the admin console when an endpoint is checked.",
    body: [
      {
        timestamp: "2026-10-14T09:20:12.418273-07:00",
        version: 1,
        type: "test",
        tailnet: "acme.dev",
        message: "This is a test event",
        data: null,
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "nodeCreated",
    name: "Node created (batched with needs approval)",
    description:
      "A new device joined the tailnet; the same request also carries its nodeNeedsApproval event.",
    body: [
      {
        timestamp: "2026-10-14T09:31:44.902617-07:00",
        version: 1,
        type: "nodeCreated",
        tailnet: "acme.dev",
        message: "Node priya-laptop.tail4c2e9.ts.net created",
        data: {
          nodeID: "nK7pQ2rTx81CNTRL",
          deviceName: "priya-laptop.tail4c2e9.ts.net",
          managedBy: "priya@acme.dev",
          actor: "priya@acme.dev",
          url: "https://login.tailscale.com/admin/machines/100.101.42.17",
        },
      },
      {
        timestamp: "2026-10-14T09:31:44.902688-07:00",
        version: 1,
        type: "nodeNeedsApproval",
        tailnet: "acme.dev",
        message: "Node priya-laptop.tail4c2e9.ts.net needs approval",
        data: {
          nodeID: "nK7pQ2rTx81CNTRL",
          deviceName: "priya-laptop.tail4c2e9.ts.net",
          managedBy: "priya@acme.dev",
          actor: "priya@acme.dev",
          url: "https://login.tailscale.com/admin/machines/100.101.42.17",
        },
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "nodeApproved",
    name: "Node approved",
    description: "An admin approved a device that was waiting for device approval.",
    body: [
      {
        timestamp: "2026-10-14T09:38:02.115904-07:00",
        version: 1,
        type: "nodeApproved",
        tailnet: "acme.dev",
        message: "Node priya-laptop.tail4c2e9.ts.net approved",
        data: {
          nodeID: "nK7pQ2rTx81CNTRL",
          deviceName: "priya-laptop.tail4c2e9.ts.net",
          managedBy: "priya@acme.dev",
          actor: "admin@acme.dev",
          url: "https://login.tailscale.com/admin/machines/100.101.42.17",
        },
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "nodeKeyExpiringInOneDay",
    name: "Node key expiring in one day",
    description: "A device's node key expires in less than 24 hours and needs re-authentication.",
    body: [
      {
        timestamp: "2026-10-14T10:26:08.775392-07:00",
        version: 1,
        type: "nodeKeyExpiringInOneDay",
        tailnet: "acme.dev",
        message: "Node build-runner-03.tail4c2e9.ts.net key expiring in less than one day",
        data: {
          nodeID: "nR3vW8mLq52CNTRL",
          url: "https://login.tailscale.com/admin/machines/100.88.7.204",
          deviceName: "build-runner-03.tail4c2e9.ts.net",
          managedBy: "ops@acme.dev",
          actor: "expiring-node-key-marker",
          expiration: "2026-10-15T08:44:46.979292Z",
        },
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "policyUpdate",
    name: "Policy file updated",
    description:
      "The tailnet policy file changed; `data` carries the old and new policy as HuJSON strings.",
    body: [
      {
        timestamp: "2026-10-14T11:05:51.512946-07:00",
        version: 1,
        type: "policyUpdate",
        tailnet: "acme.dev",
        message: "Tailnet policy file updated",
        data: {
          newPolicy:
            '{\n\t"acls": [\n\t\t{"action": "accept", "src": ["autogroup:member"], "dst": ["tag:prod:443"]},\n\t],\n}',
          oldPolicy:
            '{\n\t"acls": [\n\t\t{"action": "accept", "src": ["autogroup:member"], "dst": ["*:*"]},\n\t],\n}',
          url: "https://login.tailscale.com/admin/acls",
          actor: "admin@acme.dev",
        },
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "tailscale",
    providerLabel: "Tailscale",
    eventType: "userRoleUpdated",
    name: "User role updated",
    description: "A user's roles changed; `data` lists the old and new roles.",
    body: [
      {
        timestamp: "2026-10-14T11:49:25.208092-07:00",
        version: 1,
        type: "userRoleUpdated",
        tailnet: "acme.dev",
        message: "User priya@acme.dev role changed",
        data: {
          user: "priya@acme.dev",
          url: "https://login.tailscale.com/admin/users?q=priya%40acme.dev",
          actor: "admin@acme.dev",
          oldRoles: ["Member"],
          newRoles: ["Member", "IT admin"],
        },
      },
    ],
    docsUrl: "https://tailscale.com/kb/1213/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
