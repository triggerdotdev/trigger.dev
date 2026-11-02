import type { MetricsV1Input } from "@internal/clickhouse";
import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { createWebhookIngressRateLimiter } from "~/services/webhookIngressRateLimit.server";
import { createWebhookMetricsAggregator } from "~/services/webhookMetricsAggregator.server";
import {
  admitWebhookIngress,
  readWebhookIngressRequest,
  type WebhookIngressDeps,
} from "~/v3/webhookIngress.server";
import type { WebhookLimits } from "~/v3/webhookLimits";

vi.setConfig({ testTimeout: 60_000 });

function setup(redisOptions: {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}) {
  const redis = {
    host: redisOptions.host,
    port: redisOptions.port,
    username: redisOptions.username,
    password: redisOptions.password,
    tlsDisabled: true,
  };
  const sink = vi.fn<(rows: MetricsV1Input[]) => void>();
  const metrics = createWebhookMetricsAggregator({
    bucketSeconds: 10,
    maxEntries: 100,
    isEnabled: () => true,
    sink,
  });
  const deps: WebhookIngressDeps = {
    enabled: true,
    bodySizeLimitMb: 1,
    lookupEndpoint: async () => ({
      exists: true,
      environmentId: "env_1",
      limits: {
        endpointRateLimitTokens: 2,
        endpointRateLimitWindowSeconds: 3600,
        environmentRateLimitTokens: 100,
        environmentRateLimitWindowSeconds: 3600,
      } as WebhookLimits,
    }),
    ipLimiter: {
      blockedFor: () => undefined,
      takeBlockedLookup: () => false,
      limit: async () => ({ success: true }),
    },
    endpointLimiter: createWebhookIngressRateLimiter(redis),
    environmentLimiter: createWebhookIngressRateLimiter(redis, "webhook-ingress-env"),
    withMetrics: (environmentId, record) =>
      record(metrics, { organizationId: "org_1", projectId: "proj_1", environmentId }),
  };
  const flush = () => {
    metrics.flush();
    const rows = sink.mock.calls.flatMap(([batch]) => batch);
    sink.mockClear();
    return rows;
  };
  return { deps, flush };
}

describe("webhook ingress metrics", () => {
  redisTest(
    "a request past the endpoint limit is counted for the endpoint and its environment",
    async ({ redisOptions }) => {
      const { deps, flush } = setup(redisOptions);

      const request = () => new Request("http://localhost/webhooks/v1/ingest/wh_a");
      for (let i = 0; i < 2; i++) {
        expect(await admitWebhookIngress({ opaqueId: "wh_a" }, request(), deps)).not.toBeInstanceOf(
          Response
        );
      }
      const refused = await admitWebhookIngress({ opaqueId: "wh_a" }, request(), deps);
      expect(refused).toBeInstanceOf(Response);
      expect((refused as Response).status).toBe(429);

      const rows = flush();
      const denied = rows.filter((row) => row.metric_name === "webhook.ingress.denied");
      expect(
        denied.map((row) => [row.metric_subject, row.value, row.attributes, row.environment_id])
      ).toEqual(
        expect.arrayContaining([
          ["wh_a", 1, { scope: "endpoint" }, "env_1"],
          ["", 1, { scope: "endpoint" }, "env_1"],
        ])
      );
      expect(denied).toHaveLength(2);
      const allowed = rows.filter((row) => row.metric_name === "webhook.ingress.allowed");
      expect(allowed.map((row) => [row.metric_subject, row.value])).toEqual(
        expect.arrayContaining([
          ["wh_a", 2],
          ["", 2],
        ])
      );
      const remaining = rows.filter((row) => row.metric_name === "webhook.ingress.remaining_min");
      expect(
        remaining.map((row) => [row.metric_subject, row.value, row.attributes]).sort()
      ).toEqual([
        ["", 98, { scope: "env" }],
        ["wh_a", 0, { scope: "endpoint" }],
      ]);
    }
  );

  redisTest("a POST counts as allowed only once its body is charged", async ({ redisOptions }) => {
    const { deps, flush } = setup(redisOptions);
    const admitted = {
      opaqueId: "wh_b",
      environment: { id: "env_1", limit: { tokens: 2, windowSeconds: 3600 } },
    };
    const post = (bytes: number, headers: Record<string, string> = {}) =>
      new Request("http://localhost/webhooks/v1/ingest/wh_b", {
        method: "POST",
        body: new Uint8Array(bytes),
        headers,
      });

    const oversized = post(10, { "content-length": String(2 * 1024 * 1024) });
    const admittedPost = await admitWebhookIngress({ opaqueId: "wh_b" }, oversized, deps);
    expect(admittedPost).not.toBeInstanceOf(Response);
    const tooLarge = await readWebhookIngressRequest(
      oversized,
      admittedPost as typeof admitted,
      deps
    );
    expect((tooLarge as Response).status).toBe(413);
    expect(flush().filter((row) => /allowed|denied/.test(row.metric_name))).toEqual([]);

    const charged = await readWebhookIngressRequest(post(200 * 1024), admitted, deps);
    expect((charged as Response).status).toBe(429);
    expect(flush().map((row) => [row.metric_name, row.metric_subject, row.attributes])).toEqual([
      ["webhook.ingress.denied", "", { scope: "body" }],
    ]);

    const small = await readWebhookIngressRequest(post(10), admitted, deps);
    expect(small).not.toBeInstanceOf(Response);
    expect(
      flush()
        .filter((row) => row.metric_name === "webhook.ingress.allowed")
        .map((row) => row.metric_subject)
    ).toEqual(expect.arrayContaining(["wh_b", ""]));
  });
});
