import "dotenv/config";
import { randomBytes, createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { prisma, webhookPrisma } from "./app/db.server";

/**
 * Seed a rich, stable spread of webhook endpoints and deliveries for design work.
 *
 * Attaches several endpoints (varied providers, verifier schemes, and status) and a
 * spread of deliveries across the last two weeks (every delivery status, realistic
 * payloads + headers, a mix of test and live) to an existing DEVELOPMENT environment.
 * Writes the delivery rows to both Postgres (the source of every displayed field) and
 * ClickHouse (which orders and paginates the Deliveries list).
 *
 * By default it targets the first DEVELOPMENT environment the local user can see; set
 * WEBHOOK_SEED_PROJECT to a project name to pick a specific one.
 *
 * Re-runnable: it clears that environment's webhook deliveries first, so each run yields
 * the same clean dataset. Stale ClickHouse rows self-hide because the list drops any
 * ordered id whose Postgres row is gone.
 *
 *   pnpm --filter webapp run db:seed:webhooks
 *   pnpm --filter webapp run db:seed:webhooks -- 60   # deliveries per endpoint
 */

const PER_ENDPOINT = Number.parseInt(process.argv[2] ?? "", 10) || 45;
const SPREAD_DAYS = 14;
const DAY_MS = 86_400_000;

type Scheme = "hmac" | "shared-secret" | "url-secret" | "asymmetric";

type EndpointSpec = {
  source: string;
  handlerWebhookId: string;
  scheme: Scheme;
  verifierArtifact: unknown;
  secretProvisioning: "provider" | "integrator" | "either";
  hasSecret: boolean;
  status: "ACTIVE" | "INACTIVE";
  tenantId: string;
  externalRef: string;
  events: Array<{ type: string; body: () => Record<string, unknown> }>;
  signatureHeader: string;
  userAgent: string;
};

function hmacArtifact(preset: string, header: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "preset" as const,
    preset,
    config: {
      scheme: "hmac" as const,
      algorithm: "sha256" as const,
      encoding: "hex" as const,
      signatureHeader: header,
      signingString: "raw" as const,
      ...extra,
    },
  };
}

const ENDPOINTS: EndpointSpec[] = [
  {
    source: "stripe",
    handlerWebhookId: "stripe-webhook",
    scheme: "hmac",
    signatureHeader: "Stripe-Signature",
    userAgent: "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
    verifierArtifact: hmacArtifact("stripe", "Stripe-Signature", {
      signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1", trim: true },
      timestamp: {
        source: { from: "signatureField", field: "t" },
        unit: "seconds",
        toleranceSeconds: 300,
      },
      signingString: {
        template: "{t}.{body}",
        vars: { t: { from: "signatureField", field: "t" } },
      },
    }),
    secretProvisioning: "provider",
    hasSecret: true,
    status: "ACTIVE",
    tenantId: "",
    externalRef: "",
    events: [
      {
        type: "payment_intent.succeeded",
        body: () =>
          stripeEvent("payment_intent.succeeded", {
            amount: 4200,
            currency: "usd",
            status: "succeeded",
          }),
      },
      {
        type: "charge.refunded",
        body: () =>
          stripeEvent("charge.refunded", { amount: 4200, currency: "usd", refunded: true }),
      },
      {
        type: "customer.subscription.updated",
        body: () =>
          stripeEvent("customer.subscription.updated", { status: "active", plan: "pro_monthly" }),
      },
      {
        type: "invoice.paid",
        body: () => stripeEvent("invoice.paid", { amount_paid: 9900, currency: "usd" }),
      },
    ],
  },
  {
    source: "github",
    handlerWebhookId: "github-webhook",
    scheme: "hmac",
    signatureHeader: "X-Hub-Signature-256",
    userAgent: "GitHub-Hookshot/a1b2c3",
    verifierArtifact: hmacArtifact("github", "X-Hub-Signature-256"),
    secretProvisioning: "integrator",
    hasSecret: true,
    status: "ACTIVE",
    tenantId: "",
    externalRef: "",
    events: [
      {
        type: "push",
        body: () => ({
          ref: "refs/heads/main",
          commits: [{ id: nanoid(), message: "fix: tidy up" }],
          pusher: { name: "octocat" },
        }),
      },
      {
        type: "pull_request",
        body: () => ({
          action: "opened",
          number: 42,
          pull_request: { title: "Add webhooks", user: { login: "octocat" } },
        }),
      },
      {
        type: "issues",
        body: () => ({
          action: "opened",
          issue: { number: 7, title: "Docs typo", user: { login: "hubot" } },
        }),
      },
      {
        type: "star",
        body: () => ({
          action: "created",
          starred_at: new Date().toISOString(),
          sender: { login: "fan" },
        }),
      },
    ],
  },
  {
    source: "slack",
    handlerWebhookId: "slack-channel",
    scheme: "hmac",
    signatureHeader: "X-Slack-Signature",
    userAgent: "Slackbot 1.0 (+https://api.slack.com/robots)",
    verifierArtifact: hmacArtifact("slack", "X-Slack-Signature", {
      timestamp: {
        source: { from: "header", name: "X-Slack-Request-Timestamp" },
        unit: "seconds",
        toleranceSeconds: 300,
      },
      signingString: {
        template: "v0:{t}:{body}",
        vars: { t: { from: "header", name: "X-Slack-Request-Timestamp" } },
      },
    }),
    secretProvisioning: "provider",
    hasSecret: true,
    status: "ACTIVE",
    tenantId: "T0288ANLG",
    externalRef: "app_mention",
    events: [
      {
        type: "app_mention",
        body: () => ({
          type: "event_callback",
          event: {
            type: "app_mention",
            text: "<@U123> ship it",
            user: "U0G9QF9C6",
            channel: "C0288ANLG",
          },
        }),
      },
      {
        type: "message",
        body: () => ({
          type: "event_callback",
          event: { type: "message", text: "any update?", user: "U0G9QF9C6", channel: "C0288ANLG" },
        }),
      },
    ],
  },
  {
    source: "svix",
    handlerWebhookId: "svix-webhook",
    scheme: "hmac",
    signatureHeader: "webhook-signature",
    userAgent: "Svix-Webhooks/1.4",
    verifierArtifact: hmacArtifact("svix", "webhook-signature", {
      encoding: "base64",
      signature: { itemSeparator: " ", fieldSeparator: ",", field: "v1" },
      secret: { encoding: "base64", stripPrefix: "whsec_" },
    }),
    secretProvisioning: "provider",
    hasSecret: false,
    status: "ACTIVE",
    tenantId: "",
    externalRef: "",
    events: [
      {
        type: "invoice.created",
        body: () => ({ type: "invoice.created", data: { id: `in_${nanoid()}`, total: 1200 } }),
      },
      {
        type: "message.sent",
        body: () => ({
          type: "message.sent",
          data: { id: `msg_${nanoid()}`, to: "user@example.com" },
        }),
      },
    ],
  },
  {
    source: "discord",
    handlerWebhookId: "discord-interactions",
    scheme: "asymmetric",
    signatureHeader: "X-Signature-Ed25519",
    userAgent: "Discord-Interactions/1.0 (+https://discord.com)",
    verifierArtifact: {
      kind: "preset" as const,
      preset: "discord",
      config: {
        scheme: "asymmetric" as const,
        algorithm: "ed25519" as const,
        encoding: "hex" as const,
        signatureHeader: "X-Signature-Ed25519",
        timestamp: {
          source: { from: "header" as const, name: "X-Signature-Timestamp" },
          unit: "seconds" as const,
        },
        signingString: {
          template: "{t}{body}",
          vars: { t: { from: "header" as const, name: "X-Signature-Timestamp" } },
        },
        publicKeyEncoding: "raw-hex" as const,
      },
    },
    secretProvisioning: "provider",
    hasSecret: true,
    status: "ACTIVE",
    tenantId: "",
    externalRef: "",
    events: [
      {
        type: "INTERACTION",
        body: () => ({ type: 2, data: { name: "deploy" }, member: { user: { username: "dev" } } }),
      },
    ],
  },
  {
    source: "custom",
    handlerWebhookId: "orders-webhook",
    scheme: "shared-secret",
    signatureHeader: "X-Webhook-Token",
    userAgent: "acme-orders/2.3",
    verifierArtifact: {
      kind: "config" as const,
      config: {
        scheme: "shared-secret" as const,
        placement: "header" as const,
        fieldName: "X-Webhook-Token",
      },
    },
    secretProvisioning: "either",
    hasSecret: true,
    status: "INACTIVE",
    tenantId: "acct_9f2",
    externalRef: "orders",
    events: [
      {
        type: "order.created",
        body: () => ({
          event: "order.created",
          orderId: `ord_${nanoid()}`,
          total: 129.99,
          currency: "USD",
        }),
      },
      {
        type: "order.fulfilled",
        body: () => ({ event: "order.fulfilled", orderId: `ord_${nanoid()}`, carrier: "ups" }),
      },
    ],
  },
];

function stripeEvent(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_${nanoid()}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `obj_${nanoid()}`, ...data } },
  };
}

const STATUS_WEIGHTS: Array<[string, number]> = [
  ["SUCCEEDED", 68],
  ["FAILED", 12],
  ["FILTERED", 11],
  ["PROCESSING", 4],
  ["PENDING", 5],
];

const FAIL_REASONS = [
  "Signature verification failed",
  "Signing secret not set for endpoint",
  "Timestamp outside tolerance window",
];

function pickStatus(): string {
  const total = STATUS_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [status, w] of STATUS_WEIGHTS) {
    if ((r -= w) <= 0) return status;
  }
  return "SUCCEEDED";
}

function biasedCreatedAt(now: number): Date {
  const r = Math.random() ** 1.7;
  return new Date(now - r * SPREAD_DAYS * DAY_MS);
}

function dayPartitionName(d: Date): { name: string; lo: string; hi: string } {
  const floor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const hi = new Date(floor.getTime() + DAY_MS);
  const y = floor.getUTCFullYear();
  const m = String(floor.getUTCMonth() + 1).padStart(2, "0");
  const day = String(floor.getUTCDate()).padStart(2, "0");
  return {
    name: `WebhookDelivery_${y}_${m}_${day}`,
    lo: floor.toISOString(),
    hi: hi.toISOString(),
  };
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "local@trigger.dev" } });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  const projectName = process.env.WEBHOOK_SEED_PROJECT;
  const runtimeEnv = await prisma.runtimeEnvironment.findFirst({
    where: {
      type: "DEVELOPMENT",
      organization: { members: { some: { userId: user.id } } },
      ...(projectName ? { project: { name: projectName } } : {}),
    },
    include: { project: true, organization: true },
    orderBy: { createdAt: "asc" },
  });
  if (!runtimeEnv) {
    console.error(
      projectName
        ? `No DEVELOPMENT environment found for project "${projectName}". Run \`pnpm run db:seed\` first.`
        : "No DEVELOPMENT environment found. Run `pnpm run db:seed` first."
    );
    process.exit(1);
  }
  const org = runtimeEnv.organization;
  const project = runtimeEnv.project;
  console.log(`Seeding into ${org.title} / ${project.name} (env ${runtimeEnv.slug})`);

  const scope = {
    organizationId: org.id,
    projectId: project.id,
    runtimeEnvironmentId: runtimeEnv.id,
    environmentType: runtimeEnv.type,
  };

  console.log("Clearing previous demo deliveries...");
  await webhookPrisma.webhookDelivery.deleteMany({
    where: { runtimeEnvironmentId: runtimeEnv.id },
  });

  const endpoints: Array<{ spec: EndpointSpec; id: string; friendlyId: string }> = [];
  for (const spec of ENDPOINTS) {
    const friendlyId = `wh_${nanoid()}`;
    const created = await webhookPrisma.webhookEndpoint.upsert({
      where: {
        runtimeEnvironmentId_handlerWebhookId_endpointTenantId_endpointExternalRef: {
          runtimeEnvironmentId: runtimeEnv.id,
          handlerWebhookId: spec.handlerWebhookId,
          endpointTenantId: spec.tenantId,
          endpointExternalRef: spec.externalRef,
        },
      },
      update: {
        status: spec.status,
        verifierArtifact: spec.verifierArtifact as object,
        secretProvisioning: spec.secretProvisioning,
      },
      create: {
        friendlyId,
        opaqueId: randomBytes(16).toString("base64url"),
        ...scope,
        endpointTenantId: spec.tenantId,
        endpointExternalRef: spec.externalRef,
        source: spec.source,
        handlerWebhookId: spec.handlerWebhookId,
        routingTarget: { type: "task", taskId: spec.handlerWebhookId } as object,
        verifierArtifact: spec.verifierArtifact as object,
        secretProvisioning: spec.secretProvisioning,
        signingSecretKey: spec.hasSecret ? `webhook:signing-secret:seed-${spec.source}` : null,
        status: spec.status,
        metadata: { seeded: true, provider: spec.source } as object,
      },
    });
    endpoints.push({ spec, id: created.id, friendlyId: created.friendlyId });
  }
  console.log(`Endpoints ready: ${endpoints.length}`);

  const now = Date.now();
  type Row = {
    id: string;
    friendlyId: string;
    endpointId: string;
    source: string;
    status: string;
    isTest: boolean;
    externalDeliveryId: string;
    parsedEvent: Record<string, unknown>;
    headers: Record<string, string>;
    errorMessage: string | null;
    filterReason: string | null;
    createdAt: Date;
    processedAt: Date | null;
  };

  const rows: Row[] = [];
  for (const ep of endpoints) {
    for (let i = 0; i < PER_ENDPOINT; i++) {
      const event = ep.spec.events[Math.floor(Math.random() * ep.spec.events.length)];
      const body = event.body();
      const status =
        ep.spec.status === "INACTIVE" && Math.random() < 0.5 ? "FILTERED" : pickStatus();
      const createdAt = biasedCreatedAt(now);
      const terminal = status !== "PENDING" && status !== "PROCESSING";
      const processedAt = terminal
        ? new Date(createdAt.getTime() + 80 + Math.floor(Math.random() * 1100))
        : null;
      const externalDeliveryId = `${ep.spec.source}_${nanoid()}`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": ep.spec.userAgent,
        accept: "*/*",
        [ep.spec.signatureHeader.toLowerCase()]:
          status === "FAILED" ? "tampered" : `sig_${nanoid()}`,
      };
      // friendlyId must be the id plus the prefix, matching WebhookDeliveryId. The detail
      // lookup strips "whd_" and queries Postgres by `id`, so minting the two independently
      // makes every seeded delivery's detail page 404.
      const deliveryId = nanoid();
      rows.push({
        id: deliveryId,
        friendlyId: `whd_${deliveryId}`,
        endpointId: ep.id,
        source: ep.spec.source,
        status,
        isTest: Math.random() < 0.15,
        externalDeliveryId,
        parsedEvent: body,
        headers,
        errorMessage:
          status === "FAILED"
            ? FAIL_REASONS[Math.floor(Math.random() * FAIL_REASONS.length)]
            : null,
        filterReason:
          status === "FILTERED"
            ? `event.type "${String(body.type ?? (body as { event?: string }).event ?? "unknown")}" did not match the endpoint filter`
            : null,
        createdAt,
        processedAt,
      });
    }
  }

  const days = new Map<string, { lo: string; hi: string }>();
  for (const r of rows) {
    const p = dayPartitionName(r.createdAt);
    days.set(p.name, { lo: p.lo, hi: p.hi });
  }
  for (const [name, { lo, hi }] of days) {
    await webhookPrisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "WebhookDelivery" FOR VALUES FROM ('${lo}') TO ('${hi}')`
    );
  }
  console.log(`Ensured ${days.size} daily partitions.`);

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await webhookPrisma.webhookDelivery.createMany({
      data: chunk.map((r) => ({
        id: r.id,
        friendlyId: r.friendlyId,
        webhookEndpointId: r.endpointId,
        ...scope,
        externalDeliveryId: r.externalDeliveryId,
        idempotencyKey: r.externalDeliveryId,
        runId: null,
        status: r.status as never,
        isTest: r.isTest,
        parsedEvent: r.parsedEvent as object,
        headers: r.headers as object,
        rawBodyHash: createHash("sha256").update(JSON.stringify(r.parsedEvent)).digest("hex"),
        errorMessage: r.errorMessage,
        filterReason: r.filterReason,
        createdAt: r.createdAt,
        updatedAt: r.processedAt ?? r.createdAt,
        processedAt: r.processedAt,
      })),
    });
  }
  console.log(`Inserted ${rows.length} deliveries into Postgres.`);

  const clickhouseUrl =
    process.env.WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    console.error(
      "No ClickHouse URL (set WEBHOOK_DELIVERIES_REPLICATION_CLICKHOUSE_URL or CLICKHOUSE_URL)."
    );
    process.exit(1);
  }
  const chUrl = new URL(clickhouseUrl);
  const auth = chUrl.username
    ? "Basic " + Buffer.from(`${chUrl.username}:${chUrl.password}`).toString("base64")
    : undefined;
  const chEndpoint = `${chUrl.protocol}//${chUrl.host}/`;

  const fmt = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");
  const ndjson = rows
    .map((r) => {
      const updated = r.processedAt ?? r.createdAt;
      return JSON.stringify({
        environment_id: scope.runtimeEnvironmentId,
        organization_id: scope.organizationId,
        project_id: scope.projectId,
        delivery_id: r.id,
        webhook_endpoint_id: r.endpointId,
        environment_type: scope.environmentType,
        friendly_id: r.friendlyId,
        external_delivery_id: r.externalDeliveryId,
        run_id: "",
        status: r.status,
        is_test: r.isTest ? 1 : 0,
        created_at: fmt(r.createdAt),
        updated_at: fmt(updated),
        _version: String(updated.getTime()),
        _is_deleted: 0,
      });
    })
    .join("\n");

  const insertQuery = "INSERT INTO trigger_dev.webhook_deliveries_v1 FORMAT JSONEachRow";
  const chResponse = await fetch(`${chEndpoint}?query=${encodeURIComponent(insertQuery)}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson", ...(auth ? { authorization: auth } : {}) },
    body: ndjson,
  });
  if (!chResponse.ok) {
    console.error(`ClickHouse insert failed (${chResponse.status}): ${await chResponse.text()}`);
    process.exit(1);
  }
  console.log(`Inserted ${rows.length} delivery rows into ClickHouse.`);

  const port = process.env.REMIX_APP_PORT ?? process.env.PORT ?? "3030";
  console.log("\nDone.");
  console.log(
    `Deliveries: http://localhost:${port}/orgs/${org.slug}/projects/${project.slug}/env/${runtimeEnv.slug}/webhooks`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
