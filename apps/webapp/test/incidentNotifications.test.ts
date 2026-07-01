import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it } from "vitest";
import {
  IncidentWebhookSchema,
  isCustomerNotifiableEvent,
  normalizeIncidentUpdate,
} from "~/services/betterstack/incidentWebhook";
import {
  buildDiscordPayload,
  buildSubject,
  presentStatus,
} from "~/v3/services/alerts/incidentNotifications/messages";
import { getIncidentEmailRecipientsPage } from "~/v3/services/alerts/incidentNotifications/recipients.server";

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "incident",
    page: { id: "page_1", status_indicator: "downtime" },
    incident: {
      id: "inc_1",
      name: "Elevated error rates",
      shortlink: "https://status.trigger.dev/i/abc",
      incident_updates: [
        { id: "upd_2", body: "Identified", created_at: "2026-06-30T10:05:00Z" },
        { id: "upd_1", body: "Investigating", created_at: "2026-06-30T10:00:00Z" },
      ],
    },
    ...overrides,
  };
}

describe("incident webhook payload", () => {
  it("parses a status-page incident payload", () => {
    const parsed = IncidentWebhookSchema.safeParse(samplePayload());
    expect(parsed.success).toBe(true);
  });

  it("accepts numeric ids (BetterStack sends ids as numbers) and normalizes them to strings", () => {
    const parsed = IncidentWebhookSchema.safeParse({
      event_type: "incident",
      page: { id: 12345, status_indicator: "downtime" },
      incident: {
        id: 67890,
        name: "Numeric ids",
        incident_updates: [
          { id: 111, status_report_id: 222, body: "x", created_at: "2026-06-30T10:00:00Z" },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const normalized = normalizeIncidentUpdate(parsed.data);
      expect(normalized?.incidentId).toBe("67890");
      expect(normalized?.updateId).toBe("111");
    }
  });

  it("only treats incident events as customer-notifiable", () => {
    const incident = IncidentWebhookSchema.parse(samplePayload());
    expect(isCustomerNotifiableEvent(incident)).toBe(true);

    const maintenance = IncidentWebhookSchema.parse(samplePayload({ event_type: "maintenance" }));
    expect(isCustomerNotifiableEvent(maintenance)).toBe(false);

    const component = IncidentWebhookSchema.parse(
      samplePayload({ event_type: "component_update" })
    );
    expect(isCustomerNotifiableEvent(component)).toBe(false);
  });

  it("parses non-incident callbacks that omit the incident payload", () => {
    // Maintenance/component callbacks arrive without an `incident` field. They
    // must still parse (so the route can 200 + ignore them) rather than 400.
    const parsed = IncidentWebhookSchema.safeParse({
      event_type: "maintenance",
      page: { id: "page_1", status_indicator: "maintenance" },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isCustomerNotifiableEvent(parsed.data)).toBe(false);
      expect(normalizeIncidentUpdate(parsed.data)).toBeNull();
    }
  });

  it("normalizes to the most recent update", () => {
    const payload = IncidentWebhookSchema.parse(samplePayload());
    const normalized = normalizeIncidentUpdate(payload);

    expect(normalized).not.toBeNull();
    expect(normalized?.updateId).toBe("upd_2");
    expect(normalized?.body).toBe("Identified");
    expect(normalized?.incidentId).toBe("inc_1");
    expect(normalized?.statusIndicator).toBe("downtime");
    expect(normalized?.shortlink).toBe("https://status.trigger.dev/i/abc");
  });

  it("returns null when there are no updates", () => {
    const payload = IncidentWebhookSchema.parse(
      samplePayload({
        incident: { id: "inc_1", name: "x", incident_updates: [] },
      })
    );
    expect(normalizeIncidentUpdate(payload)).toBeNull();
  });

  it("falls back to defaults for missing name/status", () => {
    const payload = IncidentWebhookSchema.parse(
      samplePayload({
        page: {},
        incident: {
          id: "inc_2",
          name: null,
          incident_updates: [{ id: "u", body: null, created_at: null }],
        },
      })
    );
    const normalized = normalizeIncidentUpdate(payload);
    expect(normalized?.name).toBe("Service incident");
    expect(normalized?.statusIndicator).toBe("downtime");
    expect(normalized?.body).toBe("");
  });
});

describe("incident message formatting", () => {
  it("maps status indicators to presentation", () => {
    expect(presentStatus("operational").resolved).toBe(true);
    expect(presentStatus("downtime").resolved).toBe(false);
    expect(presentStatus("degraded").label).toBe("Degraded performance");
    expect(presentStatus("maintenance").label).toBe("Maintenance");
  });

  it("builds a subject with the status label", () => {
    const update = normalizeIncidentUpdate(IncidentWebhookSchema.parse(samplePayload()))!;
    expect(buildSubject(update)).toBe("[Trigger.dev Outage] Elevated error rates");
  });

  it("colors the discord embed by severity", () => {
    const resolved = buildDiscordPayload({
      incidentId: "i",
      updateId: "u",
      name: "n",
      statusIndicator: "operational",
      body: "b",
      shortlink: null,
      updatedAt: null,
    });
    expect(resolved.embeds[0].color).toBe(0x2ecc71);

    const outage = buildDiscordPayload({
      incidentId: "i",
      updateId: "u",
      name: "n",
      statusIndicator: "downtime",
      body: "b",
      shortlink: null,
      updatedAt: null,
    });
    expect(outage.embeds[0].color).toBe(0xe74c3c);
  });
});

describe("incident email recipients", () => {
  postgresTest(
    "returns distinct org admins, excludes members and deleted orgs",
    async ({ prisma }) => {
      const admin = await prisma.user.create({
        data: { email: "admin@example.com", authenticationMethod: "MAGIC_LINK" },
      });
      const member = await prisma.user.create({
        data: { email: "member@example.com", authenticationMethod: "MAGIC_LINK" },
      });

      // Admin of two orgs -> should be deduped to a single recipient.
      await prisma.organization.create({
        data: {
          title: "Org A",
          slug: "org-a",
          members: { create: { userId: admin.id, role: "ADMIN" } },
        },
      });
      await prisma.organization.create({
        data: {
          title: "Org B",
          slug: "org-b",
          members: {
            create: [
              { userId: admin.id, role: "ADMIN" },
              { userId: member.id, role: "MEMBER" },
            ],
          },
        },
      });

      // Admin of a deleted org only -> should be excluded.
      const deletedOrgAdmin = await prisma.user.create({
        data: { email: "deleted@example.com", authenticationMethod: "MAGIC_LINK" },
      });
      await prisma.organization.create({
        data: {
          title: "Org C",
          slug: "org-c",
          deletedAt: new Date(),
          members: { create: { userId: deletedOrgAdmin.id, role: "ADMIN" } },
        },
      });

      const { recipients, nextCursor } = await getIncidentEmailRecipientsPage(null, 100, prisma);
      const emails = recipients.map((r) => r.email).sort();

      expect(emails).toEqual(["admin@example.com"]);
      expect(nextCursor).toBeNull();
    },
    30_000
  );

  postgresTest(
    "paginates with a cursor",
    async ({ prisma }) => {
      for (const slug of ["p-1", "p-2", "p-3"]) {
        const user = await prisma.user.create({
          data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
        });
        await prisma.organization.create({
          data: {
            title: `Org ${slug}`,
            slug,
            members: { create: { userId: user.id, role: "ADMIN" } },
          },
        });
      }

      const first = await getIncidentEmailRecipientsPage(null, 2, prisma);
      expect(first.recipients).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await getIncidentEmailRecipientsPage(first.nextCursor, 2, prisma);
      expect(second.recipients).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      const allEmails = [...first.recipients, ...second.recipients].map((r) => r.email);
      expect(new Set(allEmails).size).toBe(3);
    },
    30_000
  );
});
