import type { AuditLogEventQuery, AuditLogListedEvent } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditLogActions,
  auditLogMenuSearch,
  parseAuditLogActions,
} from "~/components/auditLogs/auditLogEvents";
import { keyEndingSearch } from "~/components/auditLogs/AuditLogDetail";
import { targetLabel } from "~/components/auditLogs/AuditLogParts";
import { userAgentLabel } from "~/components/auditLogs/userAgentLabel";
import {
  AUDIT_LOG_MENU_LIMIT,
  AUDIT_LOG_OPENED_MENU_LIMIT,
  auditLogMenu,
  auditLogSelectedLabels,
} from "~/presenters/v3/auditLogMenus.server";
import { auditLogChangeRows } from "~/components/auditLogs/auditLogChanges";
import {
  auditLogClient,
  auditLogFilters,
  auditLogQuery,
  AuditLogPresenter,
  AuditLogSearchParams,
  invalidTimeParams,
} from "~/presenters/v3/AuditLogPresenter.server";
import { EARLIEST_EVENT } from "~/services/auditLogs/auditEventsApi.server";
import { obfuscateApiKey } from "~/utils/apiKeys";
import { seedTestUser } from "./helpers/seedTestPAT";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

/** No plan window: these tests are about filters and names, not the plan. */
const noVisibilityWindow = async () => null;

// The audit log page's data: the query it sends the plugin, and the names it shows for what the
// plugin returns, against a real database. The plugin is a function that records queries.

function listedEvent(
  organizationId: string,
  overrides: Partial<AuditLogListedEvent> = {}
): AuditLogListedEvent {
  return {
    category: "envvars",
    action: "envvar.deleted",
    id: `evt_${randomBytes(4).toString("hex")}`,
    occurredAt: new Date("2026-11-09T12:00:00.000Z"),
    organizationId,
    projectId: null,
    environmentId: null,
    environmentType: null,
    target: { type: "environment_variable", id: null, name: "API_KEY" },
    actor: { type: "system", id: null },
    credential: null,
    source: "dashboard",
    endpoint: null,
    origin: null,
    requestId: null,
    changes: null,
    ...overrides,
  } as AuditLogListedEvent;
}

function recordingPresenter(prisma: PrismaClient, events: AuditLogListedEvent[] = []) {
  const queries: AuditLogEventQuery[] = [];
  const presenter = new AuditLogPresenter(
    prisma,
    async (query) => {
      queries.push(query);
      return { events, nextCursor: "cursor_2" };
    },
    noVisibilityWindow
  );
  return { presenter, queries };
}

async function seedOrg(prisma: PrismaClient) {
  const seeded = await seedTestUserProject(prisma);
  await prisma.user.update({
    where: { id: seeded.user.id },
    data: { displayName: "Ada Lovelace", avatarUrl: "https://example.com/ada.png" },
  });
  const production = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${randomBytes(12).toString("hex")}`,
      pkApiKey: `pk_prod_${randomBytes(12).toString("hex")}`,
      shortcode: randomBytes(2).toString("hex"),
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
    },
  });
  return { ...seeded, production };
}

describe("audit log page query", () => {
  // Catches: reads flooding the default view, or a category sending the wrong actions.
  it("opens on every change without reads, and turns a category into actions", () => {
    const opened = auditLogQuery("org_1", auditLogFilters({}), {}).actions!;
    expect(opened).toEqual(auditLogActions("all", false));
    expect(opened).toContain("support.session_started");
    expect(opened).toContain("envvar.deleted");
    expect(opened).not.toContain("envvar.read");
    expect(opened).not.toContain("envvar.listed");

    const actions = (params: Record<string, string>) =>
      auditLogQuery("org_1", auditLogFilters(params), {}).actions;
    expect(actions({ category: "envvars" })).toEqual([
      "envvar.created",
      "envvar.updated",
      "envvar.value_updated",
      "envvar.deleted",
    ]);
    expect(actions({ category: "support" })).toEqual([
      "support.session_started",
      "support.session_ended",
    ]);
    // The old switch's URL value no longer adds reads.
    expect(actions({ category: "envvars", reads: "1" })).not.toContain("envvar.read");
    // An unknown category falls back to the default rather than listing everything.
    expect(actions({ category: "nope" })).toEqual(opened);
  });

  // Catches: a key's activity missing what it read, or reads flooding the log without a key.
  it("includes reads for one key or token, and when a read is picked", () => {
    const actions = (params: Record<string, string>) =>
      auditLogQuery("org_1", auditLogFilters(params), {}).actions!;
    expect(actions({ credential: "key:key_1" })).toEqual(auditLogActions("all", true));
    expect(actions({ key: "k9Qz" })).toContain("envvar.read");
    expect(actions({ key: "k9Qz", category: "envvars" })).toContain("envvar.listed");
    // A category without reads stays without them.
    expect(actions({ key: "k9Qz", category: "members" })).not.toContain("envvar.read");
    // Without a key, a read is shown only when picked as the event.
    expect(actions({ category: "envvars", action: "envvar.read" })).toEqual(["envvar.read"]);
    expect(actions({ action: "envvar.listed" })).toEqual(["envvar.listed"]);
  });

  // Catches: a pasted key's secret sent to the server, including with spaces or a newline around it.
  it("sends a pasted key as its last 4", () => {
    const key = "tr_prod_" + "a1B2".repeat(6) + "k9Qz";
    expect(auditLogMenuSearch(key)).toBe("k9Qz");
    expect(auditLogMenuSearch(`  ${key}\n`)).toBe("k9Qz");
    expect(auditLogMenuSearch("tr_pat_" + "x".repeat(20) + "Zz99")).toBe("Zz99");
    // Anything else is sent as typed.
    expect(auditLogMenuSearch("Ada")).toBe("Ada");
    expect(auditLogMenuSearch("k9Qz")).toBe("k9Qz");
  });

  // Catches: a time range that isn't a date reaching the time filter, which can't render it.
  it("finds a start or end that isn't a date", () => {
    const invalid = (query: string) => invalidTimeParams(new URLSearchParams(query));
    expect(invalid("from=not-a-date")).toEqual(["from"]);
    expect(invalid("from=2026-11-01&to=nope")).toEqual(["to"]);
    expect(invalid("from=")).toEqual(["from"]);
    expect(invalid("from=1794000000000&to=2026-11-19T10:00:00Z")).toEqual([]);
    expect(invalid("period=7d")).toEqual([]);
  });

  // Catches: an event filter that silently empties the list when it's outside the category, or a
  // read that can't be picked.
  it("narrows to one event within the category, and drops one that can't match", () => {
    expect(auditLogFilters({ action: "envvar.deleted" }).actions).toEqual(["envvar.deleted"]);
    expect(
      auditLogQuery("org_1", auditLogFilters({ action: "envvar.deleted" }), {}).actions
    ).toEqual(["envvar.deleted"]);
    expect(auditLogFilters({ action: "envvar.read" }).actions).toEqual(["envvar.read"]);
    expect(auditLogFilters({ category: "envvars", action: "envvar.read" }).actions).toEqual([
      "envvar.read",
    ]);
    expect(auditLogFilters({ category: "members", action: "envvar.read" }).actions).toBeUndefined();
    expect(
      auditLogFilters({ category: "members", action: "envvar.deleted" }).actions
    ).toBeUndefined();
    expect(auditLogFilters({ action: "auth.credential_rejected" }).actions).toBeUndefined();
  });

  // Catches: several picked events losing some, a read that can't be added to the changes, or one
  // link listing the same events in another order.
  it("narrows to several events, in the filter's order, keeping those that can match", () => {
    const actions = (params: Record<string, string>) =>
      auditLogQuery("org_1", auditLogFilters(params), {}).actions;
    expect(actions({ action: "envvar.listed,api_key.created" })).toEqual([
      "api_key.created",
      "envvar.listed",
    ]);
    expect(actions({ action: " envvar.read , envvar.read,nope" })).toEqual(["envvar.read"]);
    expect(actions({ category: "envvars", action: "api_key.created,envvar.listed" })).toEqual([
      "envvar.listed",
    ]);
    // `all` is the default filter cleared: every event the category has, reads included.
    expect(actions({ action: "all" })).toEqual(auditLogActions("all", true));
    expect(actions({ category: "envvars", action: "all" })).toEqual(
      auditLogActions("envvars", true)
    );
    expect(actions({ action: "all" })).toContain("envvar.listed");
    // Too long a param is ignored by the loader's URL schema and by the menu alike, so the chip
    // and the list agree.
    const tooLong = ["envvar.deleted", ...Array(80).fill("api_key.created")].join(",");
    expect(tooLong.length).toBeGreaterThan(1024);
    const loaded = AuditLogSearchParams.parse({ action: tooLong });
    expect(loaded.action).toBeUndefined();
    expect(auditLogQuery("org_1", auditLogFilters(loaded), loaded).actions).toEqual(actions({}));
    expect(parseAuditLogActions(tooLong, "all")).toBeUndefined();
    // Just under the limit, both read it.
    const atLimit = ["envvar.deleted", ...Array(63).fill("api_key.created")].join(",");
    expect(atLimit.length).toBeLessThanOrEqual(1024);
    expect(AuditLogSearchParams.parse({ action: atLimit }).action).toBe(atLimit);
    expect(parseAuditLogActions(atLimit, "all")).toEqual(["api_key.created", "envvar.deleted"]);
    // None that can match shows the category's events, reads left out.
    expect(actions({ category: "envvars", action: "api_key.created" })).toEqual(
      actions({ category: "envvars" })
    );
  });

  // Catches: a filter on the page that never reaches the plugin.
  it("passes the filters, the cursor and a 7 day default range to the plugin", () => {
    const before = Date.now();
    const query = auditLogQuery(
      "org_1",
      auditLogFilters({
        actor: "user_1",
        project: "proj_1",
        environment: "env_1",
        target: "API_KEY",
        key: "k9Qz",
        via: "api",
      }),
      { cursor: "cursor_1" }
    );

    expect(query).toMatchObject({
      organizationId: "org_1",
      actorId: "user_1",
      projectId: "proj_1",
      environmentId: "env_1",
      targetName: "API_KEY",
      keyLast4: "k9Qz",
      sources: ["api"],
      cursor: "cursor_1",
      limit: 50,
    });
    const days = (query.to.getTime() - query.from.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 2);
    expect(query.to.getTime()).toBeGreaterThanOrEqual(before);
  });

  // Catches: "Occurred before" searching only the 7 days before now, which drops older events or,
  // for an end older than that, starts after it ends.
  it("searches everything before an end with no start", () => {
    const to = Date.UTC(2026, 0, 10);
    const query = auditLogQuery("org_1", auditLogFilters({}), { to: String(to) });

    expect(query.from).toEqual(EARLIEST_EVENT);
    expect(query.to.getTime()).toBe(to);
  });

  // Catches: "All events for keys ending" keeping the event, Via or other filters of the page it
  // was clicked on, so it shows fewer than all of them.
  it("links a key's last 4 to all its events in the same time range", () => {
    const search = keyEndingSearch(
      "?category=credentials&action=api_key.revoked&via=api&actor=user_1&project=proj_1&from=1&to=2&cursor=c1",
      "k9Qz"
    );

    expect(Object.fromEntries(search)).toEqual({ from: "1", to: "2", key: "k9Qz" });
  });

  // Catches: a partial key reaching the plugin, which only matches whole last-4s, or a pasted
  // key searched as a whole.
  it("searches a key by its last 4 characters", () => {
    expect(auditLogFilters({ key: "k9Q" }).keyLast4).toBeUndefined();
    expect(auditLogFilters({ key: "k9Qz" }).keyLast4).toBe("k9Qz");
    expect(auditLogFilters({ key: "tr_prod_sk_abcdefghk9Qz" }).keyLast4).toBe("k9Qz");
  });

  // Catches: a Via value from a hand-edited link reaching the plugin, or no Via filtering nothing.
  it("filters by how events came in, and ignores a way it doesn't know", () => {
    expect(auditLogFilters({ via: "staff" }).via).toBe("staff");
    expect(auditLogFilters({ via: "webhook" }).via).toBeUndefined();
    expect(auditLogQuery("org_1", auditLogFilters({}), {}).sources).toBeUndefined();
  });

  // Catches: a long or odd value in a shared link failing the whole page with a 500.
  it("drops URL values it can't use instead of failing", () => {
    const parsed = AuditLogSearchParams.parse({
      target: "x".repeat(300),
      actor: "a".repeat(200),
      cursor: "c".repeat(2000),
      category: "envvars",
    });
    expect(parsed).toEqual({ category: "envvars" });
  });

  // Catches: Edge or Opera named Chrome, Chrome named Safari, or a CLI shown as a raw string.
  it("names the client from its user agent, and keeps one it doesn't know", () => {
    expect(
      userAgentLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      )
    ).toBe("Chrome 131 · macOS");
    expect(
      userAgentLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
      )
    ).toBe("Edge 131 · Windows");
    expect(
      userAgentLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Safari 18 · iOS");
    expect(
      userAgentLabel("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")
    ).toBe("Firefox 133 · Linux");
    expect(
      userAgentLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Chrome 131 · iOS");
    expect(
      userAgentLabel(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36"
      )
    ).toBe("Samsung Internet 26 · Android");
    expect(
      userAgentLabel(
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      )
    ).toBe("Chrome 131 · ChromeOS");
    // Our CLI and SDK send Node's default.
    expect(userAgentLabel("node")).toBe("Node.js");
    expect(userAgentLabel("curl/8.7.1")).toBe("curl 8.7.1");
    // A client it doesn't know, shown as sent.
    expect(userAgentLabel("some-internal-bot/2")).toBe("some-internal-bot/2");
  });

  it("names how the request reached us", () => {
    expect(auditLogClient("dashboard")).toBe("Dashboard");
    expect(auditLogClient("cli")).toBe("CLI");
    // The SDK, curl and any other API client are all API: the detail panel names the client.
    expect(auditLogClient("api")).toBe("API");
    expect(auditLogClient("run")).toBe("Task run");
    expect(auditLogClient("staff")).toBe("Trigger.dev support");
  });
});

describe("audit log changes", () => {
  const rows = (action: string, changes: Parameters<typeof auditLogChangeRows>[1], name = null) =>
    auditLogChangeRows({ action, target: { name } }, changes);

  // Catches: a list change shown as two whole lists to compare by eye, or a reorder shown as a change.
  it("shows a list field by what was added and removed", () => {
    expect(
      rows("api_key.access_changed", {
        scopes: { before: "admin", after: "read:envvars, write:envvars" },
        allowedIpRanges: { before: "", after: "198.51.100.7/32" },
      })
    ).toEqual([
      {
        label: "Scopes",
        kind: "listChanged",
        added: ["read:envvars", "write:envvars"],
        removed: ["admin"],
      },
      { label: "IP ranges", kind: "listChanged", added: ["198.51.100.7/32"], removed: [] },
    ]);
    // Same items, another order: nothing was added or removed, so it shows before and after.
    expect(
      rows("api_key.access_changed", { scopes: { before: "a, b", after: "b, a" } })[0]
    ).toMatchObject({
      kind: "changed",
    });
  });

  // Catches: raw field names, ISO timestamps, preset ids or bare last 4s reaching the panel.
  it("names fields and shows values as the dashboard does", () => {
    expect(
      rows("api_key.rotated", {
        graceUntil: "2026-11-20T13:27:51.231Z",
        newKeyLast4: "UanS",
        presetId: { before: "FULL_ACCESS", after: "ENV_VARS_ONLY" },
        expiresAt: null,
        isSecret: false,
        copiedFromEnvironmentId: "env_1",
        someNewField: "x",
      })
    ).toEqual([
      {
        label: "Grace until",
        kind: "value",
        value: { kind: "date", date: "2026-11-20T13:27:51.231Z" },
      },
      { label: "New key", kind: "value", value: { kind: "text", text: "••••UanS" } },
      {
        label: "Preset",
        kind: "changed",
        before: { kind: "text", text: "Full access" },
        after: { kind: "text", text: "Env vars only" },
      },
      { label: "Expires", kind: "value", value: { kind: "text", text: "Never" } },
      { label: "Secret", kind: "value", value: { kind: "text", text: "No" } },
      { label: "Some new field", kind: "value", value: { kind: "text", text: "x" } },
    ]);
  });

  // Catches: an env var created or deleted showing no change at all.
  it("leads with an env var created or deleted", () => {
    expect(rows("envvar.deleted", null, "API_KEY" as never)).toEqual([
      {
        label: "Variable",
        kind: "value",
        value: { kind: "text", text: "API_KEY" },
        tone: "removed",
      },
    ]);
  });
});

describe("audit log targets", () => {
  const view = (
    target: { type: string; id: string | null; name: string | null },
    category = "credentials"
  ) => ({ target, category }) as Parameters<typeof targetLabel>[0];

  // Catches: a rotated root key shown as its environment's raw id.
  it("names a root key, which is recorded without a name", () => {
    expect(targetLabel(view({ type: "root_api_key", id: "cmwnl3de0", name: null }))).toBe(
      "Root API key"
    );
    expect(
      targetLabel(view({ type: "additional_api_key", id: "key_1", name: "GitHub Actions" }))
    ).toBe("GitHub Actions");
    expect(targetLabel(view({ type: "user", id: "u_1", name: "Kim Osei" }, "support"))).toBe(
      "Organization (as Kim Osei)"
    );
  });
});

describe("AuditLogPresenter", () => {
  // Catches: ids shown instead of names, or names resolved across organizations.
  postgresTest("shows who acted and where, by name", async ({ prisma }) => {
    const { user, organization, project, production, pat } = await seedOrg(prisma);
    const other = await seedOrg(prisma);
    const createDeployment = (projectId: string, environmentId: string, version: string) =>
      prisma.workerDeployment.create({
        data: {
          projectId,
          environmentId,
          friendlyId: `deployment_${version.replace(".", "_")}_${projectId}`,
          shortCode: `sc_${version.replace(".", "_")}_${projectId.slice(-6)}`,
          version,
          contentHash: "hash",
        },
      });
    const deployment = await createDeployment(project.id, production.id, "20261104.3");
    const otherDeployment = await createDeployment(
      other.project.id,
      other.production.id,
      "20261104.9"
    );
    // Started a build, and acted in no other event, so only the build names her.
    const grace = await seedTestUser(prisma);
    await prisma.user.update({ where: { id: grace.id }, data: { displayName: "Grace Hopper" } });
    // Support signed in as her, and she acted in no other event, so only the session names her.
    const margaret = await seedTestUser(prisma);
    await prisma.user.update({
      where: { id: margaret.id },
      data: { displayName: "Margaret Hamilton" },
    });
    const oat = await prisma.organizationAccessToken.create({
      data: {
        name: "ci-sync",
        hashedToken: randomBytes(16).toString("hex"),
        organizationId: organization.id,
      },
    });
    const { presenter, queries } = recordingPresenter(prisma, [
      listedEvent(organization.id, {
        id: "evt_user",
        actor: { type: "user", id: user.id },
        credential: { kind: "pat", id: pat.id, last4: "ab12" },
        source: "api",
        projectId: project.id,
        environmentId: production.id,
        environmentType: "PRODUCTION",
        endpoint: {
          ip: "203.0.113.7",
          userAgent: "node",
          location: { countryCode: "DE", asn: 16509, asName: "Amazon" },
        },
      }),
      listedEvent(organization.id, {
        id: "evt_key",
        actor: { type: "api_key", id: production.id },
        credential: { kind: "root_api_key", id: production.id, last4: "k9Qz" },
        environmentType: "PRODUCTION",
        source: "api",
      }),
      listedEvent(organization.id, {
        id: "evt_additional_key",
        actor: { type: "api_key", id: "key_1" },
        credential: { kind: "additional_api_key", id: "key_1", last4: "a1b2" },
        environmentType: "STAGING",
        source: "api",
      }),
      // Ada in the dashboard: no credential.
      listedEvent(organization.id, { id: "evt_dashboard", actor: { type: "user", id: user.id } }),
      // A build's own deploy key, for this org's deployment, and naming another org's.
      listedEvent(organization.id, {
        id: "evt_build",
        actor: { type: "trigger_infra", id: null },
        origin: { deploymentId: deployment.friendlyId },
      }),
      listedEvent(organization.id, {
        id: "evt_build_foreign",
        actor: { type: "trigger_infra", id: null },
        origin: { deploymentId: otherDeployment.friendlyId },
      }),
      listedEvent(organization.id, {
        id: "evt_oat",
        actor: { type: "oat", id: oat.id },
        credential: { kind: "oat", id: oat.id, last4: "zz99" },
        source: "api",
      }),
      // Another org's project and environment: never named here.
      listedEvent(organization.id, {
        id: "evt_foreign",
        projectId: other.project.id,
        environmentId: other.production.id,
      }),
      // Support signed in as Margaret: the session names her, as the target.
      listedEvent(organization.id, {
        id: "evt_support",
        category: "support",
        action: "support.session_started",
        target: { type: "user", id: margaret.id, name: null },
        actor: { type: "support", id: "staff_1" },
        source: "staff",
      }),
      listedEvent(organization.id, { id: "evt_run", actor: { type: "run", id: "run_1" } }),
      // Support impersonating Ada: her id as the actor, staff as the source.
      listedEvent(organization.id, {
        id: "evt_impersonated",
        actor: { type: "user", id: user.id },
        source: "staff",
        credential: { kind: "pat", id: "pat_staff", last4: "st4f" },
      }),
    ]);

    const page = await presenter.call(organization.id, {});
    const byId = new Map(page.events.map((event) => [event.id, event]));

    expect(queries).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor_2");
    expect(page.error).toBeNull();

    const byUser = byId.get("evt_user")!;
    // A PAT is its owner's: the user acted, and the label says with which token.
    expect(byUser.actor).toEqual({
      kind: "user",
      id: user.id,
      name: "Ada Lovelace",
      email: user.email,
      avatarUrl: "https://example.com/ada.png",
      label: "PAT · e2e-test-pat (Ada Lovelace)",
      bySupport: false,
      withPat: true,
    });
    expect(byUser.credential).toBe('Personal access token "e2e-test-pat", owner Ada Lovelace');
    expect(byId.get("evt_dashboard")!.actor).toMatchObject({
      label: "Ada Lovelace",
      withPat: false,
    });
    expect(byId.get("evt_dashboard")!.credential).toBeNull();
    expect(byId.get("evt_impersonated")!.actor).toMatchObject({
      kind: "user",
      label: "Trigger.dev support (as Ada Lovelace)",
      bySupport: true,
      withPat: false,
    });
    expect(byId.get("evt_impersonated")!.credential).toBe("Support access session");
    expect(byUser.project).toEqual({ id: project.id, name: project.name });
    expect(byUser.environment).toMatchObject({ id: production.id, type: "PRODUCTION" });
    expect(byUser.client).toBe("API");
    expect(byUser.ip).toBe("203.0.113.7");
    expect(byUser.location).toEqual({ countryCode: "DE", asn: 16509, asName: "Amazon" });
    expect(byId.get("evt_key")!.location).toBeNull();
    expect(byUser.actionLabel).toBe("Environment variable deleted");

    expect(byId.get("evt_key")!.actor).toEqual({
      kind: "credential",
      label: "tr_prod_••••••••k9Qz",
      credential: "key",
    });
    // Masked as elsewhere in the dashboard; the detail panel says which kind of key.
    expect(byId.get("evt_key")!.credential).toBe("Secret API key (prod)");
    // The detail panel links to every event involving a key ending the same way.
    expect(byId.get("evt_key")!.credentialLast4).toBe("k9Qz");
    // Support never: what staff acted with isn't shown.
    expect(byId.get("evt_impersonated")!.credentialLast4).toBeNull();
    expect(byId.get("evt_additional_key")!.actor).toEqual({
      kind: "credential",
      label: "tr_stg_sk_••••••••a1b2",
      credential: "key",
    });
    expect(byId.get("evt_additional_key")!.credential).toBe("Additional API key (staging)");
    expect(byId.get("evt_oat")!.actor).toEqual({
      kind: "credential",
      label: "Org token · ci-sync",
      credential: "token",
    });
    expect(byId.get("evt_oat")!.credential).toBe('Organization access token "ci-sync"');

    const build = byId.get("evt_build")!;
    expect(build.actor).toEqual({ kind: "infrastructure", label: "Trigger.dev infrastructure" });
    expect(build.credential).toBe("Deployment 20261104.3");
    // Linked by short code, within the org's project and environment.
    expect(build.deployment).toEqual({
      friendlyId: deployment.friendlyId,
      version: "20261104.3",
      shortCode: deployment.shortCode,
      projectSlug: project.slug,
      environmentSlug: production.slug,
    });
    // Another org's deployment is never looked up: no link, only the id that was recorded.
    expect(byId.get("evt_build_foreign")!.deployment).toBeNull();
    expect(byId.get("evt_build_foreign")!.credential).toBe(
      `Deployment ${otherDeployment.friendlyId}`
    );
    expect(byUser.deployment).toBeNull();
    expect(byId.get("evt_foreign")!.project).toBeNull();
    expect(byId.get("evt_foreign")!.environment).toBeNull();
    // Only that support acted, never who.
    expect(byId.get("evt_support")!.actor).toEqual({
      kind: "support",
      label: "Trigger.dev support",
    });
    expect(JSON.stringify(byId.get("evt_support")!.actor)).not.toContain("staff_1");
    expect(byId.get("evt_support")!.credential).toBe("Support access session");
    expect(byId.get("evt_support")!.target).toEqual({
      type: "user",
      id: margaret.id,
      name: "Margaret Hamilton",
    });
    expect(byId.get("evt_run")!.actor).toEqual({ kind: "run", label: "Run run_1" });
  });

  // Catches: a ClickHouse outage or a stale cursor crashing the page instead of explaining.
  postgresTest("explains a store failure and a rejected query", async ({ prisma }) => {
    const failWith = (name: string) =>
      new AuditLogPresenter(
        prisma,
        async () => {
          const error = new Error("detail that stays internal");
          error.name = name;
          throw error;
        },
        noVisibilityWindow
      );

    const unavailable = await failWith("AuditLogReadError").call("org_1", {});
    expect(unavailable).toMatchObject({ events: [], nextCursor: null });
    expect(unavailable.error).toMatch(/temporarily unavailable/);
    expect(unavailable.error).not.toContain("detail that stays internal");

    const invalid = await failWith("AuditLogQueryError").call("org_1", { cursor: "garbage" });
    expect(invalid.error).toBe("These filters aren't valid.");

    await expect(failWith("TypeError").call("org_1", {})).rejects.toThrow(
      "detail that stays internal"
    );
  });

  // Catches: an inverted custom range reaching the store, which would scan for nothing.
  postgresTest("explains a time range that ends before it starts", async ({ prisma }) => {
    const { presenter, queries } = recordingPresenter(prisma);

    const page = await presenter.call("org_1", {
      from: String(Date.parse("2026-11-10T00:00:00Z")),
      to: String(Date.parse("2026-11-01T00:00:00Z")),
    });

    expect(page.error).toBe("The start of the time range must be before its end.");
    expect(queries).toHaveLength(0);
  });

  // Catches: a picked credential queried by anything but what its events recorded, a malformed
  // reference sent on, or a query that isn't scoped to the organization.
  it("filters by what a picked credential's events recorded", async () => {
    const { presenter, queries } = recordingPresenter(null as unknown as PrismaClient);
    const credentialFor = async (credential: string) => {
      await presenter.call("org_1", { credential });
      return queries[queries.length - 1]?.credential;
    };

    // A root key by its environment and last 4, current or rotated, with the public JWTs it signed.
    expect(await credentialFor("root:env_1:k9Qz")).toEqual({
      kinds: ["root_api_key", "public_jwt"],
      id: "env_1",
      last4: "k9Qz",
    });
    // Without a last 4, every root key the environment has had.
    expect(await credentialFor("root:env_1")).toEqual({
      kinds: ["root_api_key", "public_jwt"],
      id: "env_1",
      last4: undefined,
    });
    expect(await credentialFor("key:key_1")).toEqual({
      kinds: ["additional_api_key"],
      id: "key_1",
    });
    expect(await credentialFor("oat:oat_1")).toEqual({ kinds: ["oat"], id: "oat_1" });
    expect(await credentialFor("pat:pat_1")).toEqual({ kinds: ["pat"], id: "pat_1" });
    // Another organization's id still goes out with this organization's id: it matches nothing.
    expect(queries.every((query) => query.organizationId === "org_1")).toBe(true);

    // Malformed references, and the earlier `rotated:` form, filter by nothing.
    for (const credential of ["rotated:rak_1", "root:env_1:toolong", "key:", "fp:fp_1"]) {
      expect(await credentialFor(credential)).toBeUndefined();
    }
  });

  // Catches: a member's token named from a link although it only acts in other organizations.
  postgresTest("names a picked PAT only when it has events in this org", async ({ prisma }) => {
    const { user, organization, pat } = await seedOrg(prisma);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // A store that filters like the plugin does: by credential and time range.
    const presenterOver = (events: AuditLogListedEvent[]) =>
      new AuditLogPresenter(
        prisma,
        async (query) => ({
          events: events
            .filter(
              (event) =>
                !!event.credential &&
                !!query.credential?.kinds.includes(event.credential.kind) &&
                event.credential?.id === query.credential?.id &&
                event.occurredAt >= query.from &&
                event.occurredAt < query.to
            )
            .slice(0, query.limit),
          nextCursor: null,
        }),
        noVisibilityWindow
      );
    const used = listedEvent(organization.id, {
      occurredAt: monthAgo,
      actor: { type: "user", id: user.id },
      credential: { kind: "pat", id: pat.id, last4: pat.token.slice(-4) },
    });

    // It acted here, before the default 7 days the page shows.
    const acted = await presenterOver([used]).call(organization.id, {
      credential: `pat:${pat.id}`,
    });
    expect(acted.events).toEqual([]);
    expect(acted.patActedHere).toBe(true);
    // No events in this org.
    const never = await presenterOver([]).call(organization.id, { credential: `pat:${pat.id}` });
    expect(never.patActedHere).toBe(false);

    const label = async (patActedHere: boolean | undefined) =>
      (
        await auditLogSelectedLabels(prisma, organization.id, {
          credential: `pat:${pat.id}`,
          patActedHere,
        })
      ).credential;
    expect(await label(true)).toBe("PAT · e2e-test-pat");
    expect(await label(false)).toBe("Personal access token");
    expect(await label(undefined)).toBe("Personal access token");
  });
});

describe("audit log filter menus", () => {
  async function environmentFor(
    prisma: PrismaClient,
    projectId: string,
    organizationId: string,
    data: Partial<{
      type: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
      branchName: string;
      parentEnvironmentId: string;
      orgMemberId: string;
    }>
  ) {
    return prisma.runtimeEnvironment.create({
      data: {
        slug: `env-${randomBytes(4).toString("hex")}`,
        type: data.type ?? "PREVIEW",
        apiKey: `tr_${randomBytes(12).toString("hex")}`,
        pkApiKey: `pk_${randomBytes(12).toString("hex")}`,
        shortcode: randomBytes(3).toString("hex"),
        projectId,
        organizationId,
        branchName: data.branchName,
        parentEnvironmentId: data.parentEnvironmentId,
        orgMemberId: data.orgMemberId,
      },
    });
  }

  /** Ada's org with a second member, Grace, who has her own dev environment in Ada's project. */
  async function orgWithTwoMembers(prisma: PrismaClient) {
    const ada = await seedOrg(prisma);
    const grace = await seedTestUser(prisma);
    await prisma.user.update({ where: { id: grace.id }, data: { displayName: "Grace Hopper" } });
    const graceMember = await prisma.orgMember.create({
      data: { organizationId: ada.organization.id, userId: grace.id },
    });
    const graceDev = await environmentFor(prisma, ada.project.id, ada.organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: graceMember.id,
    });
    return { ...ada, grace, graceDev };
  }

  const menu = (
    prisma: PrismaClient,
    name: Parameters<typeof auditLogMenu>[1],
    query: Parameters<typeof auditLogMenu>[2]
  ) => auditLogMenu(prisma, name, query);

  // Catches: another org's members or projects offered, the viewer not listed first, a search that
  // misses an email or display name, or "_" and "%" searched as wildcards.
  postgresTest("lists and searches the org's own members and projects", async ({ prisma }) => {
    const { user, organization, project, grace } = await orgWithTwoMembers(prisma);
    const other = await seedOrg(prisma);
    const query = { organizationId: organization.id, viewerId: grace.id, search: "" };

    const members = await menu(prisma, "actor", query);
    // Members first (the viewer at the top), then the org's keys.
    expect(members.items.slice(0, 2).map((item) => item.label)).toEqual([
      "Grace Hopper",
      "Ada Lovelace",
    ]);
    const byEmail = await menu(prisma, "actor", { ...query, search: user.email.toUpperCase() });
    expect(byEmail.items.map((item) => item.value)).toEqual([user.id]);
    expect((await menu(prisma, "actor", { ...query, search: other.user.email })).items).toEqual([]);
    const people = async (search: string) =>
      (await menu(prisma, "actor", { ...query, search })).items
        .map((item) => item.value)
        .filter((value) => value === user.id || value === grace.id);
    expect(await people("hopper")).toEqual([grace.id]);
    // "_" and "%" match themselves: as wildcards, "a_a" would find Ada.
    expect(await people("a_a")).toEqual([]);
    expect(await people("%")).toEqual([]);

    // Opened: each project, followed by its environments.
    const places = await menu(prisma, "place", query);
    expect(places.items[0]).toEqual({ value: `project:${project.id}`, label: project.name });
    expect(
      places.items.slice(1).every((item) => item.value.startsWith(`environment:${project.id}:`))
    ).toBe(true);
    expect(places.items.length).toBeGreaterThan(1);
    expect((await menu(prisma, "place", { ...query, search: other.project.name })).items).toEqual(
      []
    );
  });

  // Catches: another org's project listed or picked, other members' dev environments offered, the
  // picked project's environments missing, or a menu that grows past its cap.
  postgresTest(
    "lists projects with the picked one's environments first, capped, and searches both",
    async ({ prisma }) => {
      const { user, organization, project, production, environment, graceDev } =
        await orgWithTwoMembers(prisma);
      const other = await seedOrg(prisma);
      const preview = await environmentFor(prisma, project.id, organization.id, {
        type: "PREVIEW",
      });
      for (let index = 0; index < AUDIT_LOG_MENU_LIMIT + 2; index++) {
        await environmentFor(prisma, project.id, organization.id, {
          branchName: `branch-${index}`,
          parentEnvironmentId: preview.id,
        });
      }
      const query = { organizationId: organization.id, viewerId: user.id, search: "" };
      const values = (page: { items: Array<{ value: string }> }) =>
        page.items.map((item) => item.value);
      const place = (id: string) => `environment:${project.id}:${id}`;

      // Another org's project as the picked one is ignored: the menu opens on this org's projects.
      const foreign = await menu(prisma, "place", { ...query, projectId: other.project.id });
      expect(values(foreign)[0]).toBe(`project:${project.id}`);
      expect(values(foreign).some((value) => value.includes(other.project.id))).toBe(false);
      // Branches aren't listed when opened, but a search finds them: the menu says there's more.
      expect(foreign.more).toBe(true);

      const picked = await menu(prisma, "place", { ...query, projectId: project.id });
      expect(picked.items).toHaveLength(AUDIT_LOG_OPENED_MENU_LIMIT);
      expect(picked.more).toBe(true);
      expect(picked.items.slice(0, 4)).toEqual([
        { value: `project:${project.id}`, label: `All of ${project.name}` },
        {
          value: place(production.id),
          label: `${project.name} · Production`,
          environment: { type: "PRODUCTION", name: "Production" },
        },
        {
          value: place(preview.id),
          label: `${project.name} · Preview`,
          environment: { type: "PREVIEW", name: "Preview" },
        },
        {
          value: place(environment.id),
          label: `${project.name} · Development (you)`,
          environment: { type: "DEVELOPMENT", name: "Development (you)" },
        },
      ]);
      expect(values(picked)).not.toContain(place(graceDev.id));

      const branch = await menu(prisma, "place", { ...query, search: "branch-26" });
      expect(branch.items).toEqual([
        {
          value: expect.stringMatching(/^environment:/),
          label: `${project.name} · branch-26`,
          environment: { type: "PREVIEW", name: "branch-26" },
        },
      ]);
      const byName = await menu(prisma, "place", { ...query, search: project.name });
      expect(values(byName).slice(0, 4)).toEqual([
        `project:${project.id}`,
        place(production.id),
        place(preview.id),
        place(environment.id),
      ]);
      expect(values(byName)).not.toContain(place(graceDev.id));
      // An environment's name finds it in every project; another member's development never.
      const byType = await menu(prisma, "place", { ...query, search: "prod" });
      expect(byType.items).toEqual([
        {
          value: place(production.id),
          label: `${project.name} · Production`,
          environment: { type: "PRODUCTION", name: "Production" },
        },
      ]);
      const development = await menu(prisma, "place", { ...query, search: "develop" });
      expect(values(development)).toEqual([place(environment.id)]);
    }
  );

  // Catches: keys listed without a project, another member's dev key or another org's keys offered.
  postgresTest(
    "offers org tokens, and a project's keys but not other members' dev keys",
    async ({ prisma }) => {
      const { user, organization, project, production, environment, graceDev } =
        await orgWithTwoMembers(prisma);
      const other = await seedOrg(prisma);
      await prisma.apiKey.create({
        data: {
          name: "GitHub Actions",
          keyHash: randomBytes(32).toString("hex"),
          lastFour: "a1b2",
          runtimeEnvironmentId: production.id,
          scopes: ["admin"],
        },
      });
      const rotated = await prisma.revokedApiKey.create({
        data: {
          apiKey: `tr_prod_${randomBytes(12).toString("hex")}`,
          runtimeEnvironmentId: production.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const oat = await prisma.organizationAccessToken.create({
        data: {
          name: "deploy-bot",
          hashedToken: randomBytes(32).toString("hex"),
          organizationId: organization.id,
        },
      });
      const query = { organizationId: organization.id, viewerId: user.id, search: "" };

      // Without a project or a search: the org's current keys, labelled with their project, and
      // its tokens. Not rotated keys (a search finds them), nor another member's dev key.
      const withoutProject = await menu(prisma, "credential", query);
      const openValues = withoutProject.items.map((item) => item.value);
      expect(openValues).toEqual(
        expect.arrayContaining([
          `root:${production.id}:${production.apiKey.slice(-4)}`,
          `root:${environment.id}:${environment.apiKey.slice(-4)}`,
          `oat:${oat.id}`,
        ])
      );
      expect(openValues).not.toContain(`root:${production.id}:${rotated.apiKey.slice(-4)}`);
      // The rotated key isn't listed, but a search finds it: the menu says there's more.
      expect(withoutProject.more).toBe(true);
      expect(openValues.some((value) => value.includes(graceDev.id))).toBe(false);
      expect(withoutProject.items[0]?.label.startsWith(`${project.name} · `)).toBe(true);

      // Without a project, keys are found by last 4 or project name, labelled with the project.
      const byLast4 = await menu(prisma, "credential", { ...query, search: "a1b2" });
      expect(byLast4.items.map((item) => item.label)).toEqual([
        `${project.name} · ${obfuscateApiKey("PRODUCTION", "a1b2", "additional")}`,
      ]);
      const rootLast4 = production.apiKey.slice(-4);
      expect(
        (await menu(prisma, "credential", { ...query, search: rootLast4 })).items.map(
          (item) => item.value
        )
      ).toContain(`root:${production.id}:${rootLast4}`);
      const byProject = (await menu(prisma, "credential", { ...query, search: project.name }))
        .items;
      expect(byProject.map((item) => item.value)).toEqual(
        expect.arrayContaining([
          `root:${production.id}:${rootLast4}`,
          `root:${production.id}:${rotated.apiKey.slice(-4)}`,
        ])
      );
      // Only the exact last 4: a longer ending of the secret would reveal it a character at a time.
      for (const ending of [production.apiKey.slice(-5), production.apiKey.slice(-12)]) {
        const found = (await menu(prisma, "credential", { ...query, search: ending })).items;
        expect(found.some((item) => item.value.startsWith(`root:${production.id}:`))).toBe(false);
      }
      const rotatedEnding = rotated.apiKey.slice(-5);
      expect((await menu(prisma, "credential", { ...query, search: rotatedEnding })).items).toEqual(
        []
      );
      // Not another member's dev key, nor another org's keys, whatever the search.
      for (const search of [graceDev.apiKey.slice(-4), other.production.apiKey.slice(-4)]) {
        const found = (await menu(prisma, "credential", { ...query, search })).items;
        expect(found.some((item) => item.value.includes(graceDev.id))).toBe(false);
        expect(found.some((item) => item.value.includes(other.production.id))).toBe(false);
      }

      const keys = await menu(prisma, "credential", { ...query, projectId: project.id });
      const values = keys.items.map((item) => item.value);
      // Root keys by environment and last 4, so a rotated one is told apart from the current one.
      const root = (environmentId: string, apiKey: string) =>
        `root:${environmentId}:${apiKey.slice(-4)}`;
      expect(values).toEqual(
        expect.arrayContaining([
          root(production.id, production.apiKey),
          root(environment.id, environment.apiKey),
          root(production.id, rotated.apiKey),
          `oat:${oat.id}`,
        ])
      );
      expect(
        keys.items.find((item) => item.value === root(production.id, production.apiKey))?.label
      ).toBe(obfuscateApiKey("PRODUCTION", production.apiKey.slice(-4)));
      expect(
        keys.items.some(
          (item) => item.label === obfuscateApiKey("PRODUCTION", "a1b2", "additional")
        )
      ).toBe(true);
      expect(values.some((value) => value.startsWith(`root:${graceDev.id}`))).toBe(false);
      expect(values.some((value) => value.startsWith("pat:"))).toBe(false);

      const foreign = await menu(prisma, "credential", { ...query, projectId: other.project.id });
      expect(foreign.items.map((item) => item.value)).toEqual([`oat:${oat.id}`]);
      expect((await menu(prisma, "credential", { ...query, search: "deploy" })).items).toHaveLength(
        1
      );
    }
  );

  // Catches: the actor menu leaving out the keys and tokens the actor column shows.
  postgresTest("offers members, then keys and tokens, as actors", async ({ prisma }) => {
    const { user, organization, project, production } = await seedOrg(prisma);
    const oat = await prisma.organizationAccessToken.create({
      data: {
        name: "deploy-bot",
        hashedToken: randomBytes(32).toString("hex"),
        organizationId: organization.id,
      },
    });
    const query = { organizationId: organization.id, viewerId: user.id, search: "" };

    // Opened: members first, then keys and tokens.
    const all = await menu(prisma, "actor", query);
    const allValues = all.items.map((item) => item.value);
    expect(allValues[0]).toBe(user.id);
    expect(allValues).toEqual(
      expect.arrayContaining([
        `root:${production.id}:${production.apiKey.slice(-4)}`,
        `oat:${oat.id}`,
      ])
    );

    const last4 = production.apiKey.slice(-4);
    const found = await menu(prisma, "actor", { ...query, search: last4 });
    // Four characters also offer every event involving a key with that last 4, first.
    expect(found.items[0]).toEqual({
      value: `last4:${last4}`,
      label: `Any key ending ••••••••${last4}`,
      detail: "Used or changed",
    });
    // Anything but 4 characters doesn't.
    expect(
      (await menu(prisma, "actor", { ...query, search: "Ada" })).items.some((item) =>
        item.value.startsWith("last4:")
      )
    ).toBe(false);
    expect(found.items.map((item) => item.label)).toContain(
      `${project.name} · ${obfuscateApiKey("PRODUCTION", last4)}`
    );
    const inProject = await menu(prisma, "actor", { ...query, projectId: project.id });
    expect(inProject.items.map((item) => item.value)).toContain(`root:${production.id}:${last4}`);
  });

  // Catches: members matching a search crowding out keys and tokens, a dropped match with no "more",
  // or the viewer missing from the opened menu when they sort after the first page.
  postgresTest(
    "keeps room for keys among many members, and the viewer first",
    async ({ prisma }) => {
      const { user, organization } = await seedOrg(prisma);
      await prisma.user.update({ where: { id: user.id }, data: { displayName: "Zed Viewer" } });
      for (let index = 0; index < AUDIT_LOG_MENU_LIMIT + 5; index++) {
        const member = await seedTestUser(prisma);
        await prisma.user.update({
          where: { id: member.id },
          data: { name: `Acme person ${String(index).padStart(2, "0")}`, displayName: null },
        });
        await prisma.orgMember.create({
          data: { organizationId: organization.id, userId: member.id },
        });
      }
      const token = await prisma.organizationAccessToken.create({
        data: {
          name: "acme-bot",
          hashedToken: randomBytes(32).toString("hex"),
          organizationId: organization.id,
        },
      });
      const query = { organizationId: organization.id, viewerId: user.id, search: "" };

      const opened = await menu(prisma, "actor", query);
      expect(opened.items[0]?.value).toBe(user.id);

      // "acme" matches 30 members, is a possible last 4, and names the token.
      const acme = await menu(prisma, "actor", { ...query, search: "acme" });
      expect(acme.items).toHaveLength(AUDIT_LOG_MENU_LIMIT);
      expect(acme.items[0]?.value).toBe("last4:acme");
      expect(acme.items.map((item) => item.value)).toContain(`oat:${token.id}`);
      expect(acme.more).toBe(true);
    }
  );

  // Catches: a root key's last 4 missed for its case, or an older rotation cut off before matching.
  postgresTest("finds keys by last 4 in any case, and older rotations", async ({ prisma }) => {
    const { user, organization, project, production } = await seedOrg(prisma);
    const mixedCase = `tr_prod_${randomBytes(8).toString("hex")}K9Qz`;
    await prisma.runtimeEnvironment.update({
      where: { id: production.id },
      data: { apiKey: mixedCase },
    });
    const rotations = [];
    for (let index = 0; index < AUDIT_LOG_MENU_LIMIT + 3; index++) {
      rotations.push(
        await prisma.revokedApiKey.create({
          data: {
            apiKey: `tr_prod_${randomBytes(12).toString("hex")}`,
            runtimeEnvironmentId: production.id,
            expiresAt: new Date(Date.now() + 86_400_000),
            createdAt: new Date(Date.now() - (index + 1) * 60_000),
          },
        })
      );
    }
    const oldest = rotations[rotations.length - 1]!;
    const query = { organizationId: organization.id, viewerId: user.id, search: "" };
    const values = async (search: string, projectId?: string) =>
      (await menu(prisma, "credential", { ...query, search, projectId })).items.map(
        (item) => item.value
      );

    expect(await values("k9qz")).toContain(`root:${production.id}:K9Qz`);
    const oldestLast4 = oldest.apiKey.slice(-4);
    expect(await values(oldestLast4, project.id)).toContain(`root:${production.id}:${oldestLast4}`);
    // A four-letter word still matches rotations by their label, not only as a last 4.
    const newest = rotations[0]!;
    expect(await values("prod", project.id)).toContain(
      `root:${production.id}:${newest.apiKey.slice(-4)}`
    );
  });

  // Catches: a picked project's branch pushed out of a search by newer branches elsewhere.
  postgresTest("searches the picked project's branches first", async ({ prisma }) => {
    const { user, organization, project } = await seedOrg(prisma);
    const preview = await environmentFor(prisma, project.id, organization.id, { type: "PREVIEW" });
    const mine = await environmentFor(prisma, project.id, organization.id, {
      branchName: "main",
      parentEnvironmentId: preview.id,
    });
    const other = await prisma.project.create({
      data: {
        name: "other",
        slug: `other-${randomBytes(3).toString("hex")}`,
        externalRef: `proj_${randomBytes(10).toString("hex")}`,
        organizationId: organization.id,
      },
    });
    const otherPreview = await environmentFor(prisma, other.id, organization.id, {
      type: "PREVIEW",
    });
    for (let index = 0; index < AUDIT_LOG_MENU_LIMIT + 2; index++) {
      await environmentFor(prisma, other.id, organization.id, {
        branchName: `main-${index}`,
        parentEnvironmentId: otherPreview.id,
      });
    }
    const found = await menu(prisma, "place", {
      organizationId: organization.id,
      viewerId: user.id,
      search: "main",
      projectId: project.id,
    });
    expect(found.items.map((item) => item.value)).toContain(`environment:${project.id}:${mine.id}`);
  });

  // Catches: a picked value outside a menu's first page shown as unknown, or another org's named.
  postgresTest("names the picked values, and nothing from another org", async ({ prisma }) => {
    const { organization, project, grace, graceDev } = await orgWithTwoMembers(prisma);
    const other = await seedOrg(prisma);

    expect(
      await auditLogSelectedLabels(prisma, organization.id, {
        actorId: grace.id,
        projectId: project.id,
        environmentId: graceDev.id,
        credential: `root:${graceDev.id}:${graceDev.apiKey.slice(-4)}`,
      })
    ).toEqual({
      actor: "Grace Hopper",
      place: `${project.name} · Development (Grace Hopper)`,
      placeEnvironment: { type: "DEVELOPMENT", name: "Development (Grace Hopper)" },
      credential: obfuscateApiKey("DEVELOPMENT", graceDev.apiKey.slice(-4)),
    });
    // A last 4 the environment's key doesn't have now: a key from before a rotation.
    expect(
      (
        await auditLogSelectedLabels(prisma, organization.id, {
          credential: `root:${graceDev.id}:R0tD`,
        })
      ).credential
    ).toBe(`${obfuscateApiKey("DEVELOPMENT", "R0tD")} (rotated)`);
    expect(
      await auditLogSelectedLabels(prisma, organization.id, {
        // Someone who isn't a member: never named from a link.
        actorId: other.user.id,
        projectId: other.project.id,
        environmentId: other.production.id,
        credential: `root:${other.production.id}`,
      })
    ).toEqual({
      actor: undefined,
      place: undefined,
      placeEnvironment: undefined,
      credential: undefined,
    });
  });
});
