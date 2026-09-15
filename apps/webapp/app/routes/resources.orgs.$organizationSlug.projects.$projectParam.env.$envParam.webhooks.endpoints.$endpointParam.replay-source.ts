import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, webhookReplica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WebhookDetailPresenter } from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

const ParamsSchema = EnvironmentParamSchema.extend({ endpointParam: z.string() });

const RECENT_DELIVERIES_LIMIT = 20;

export type ReplaySourceDelivery = {
  friendlyId: string;
  status: string;
  isTest: boolean;
  externalDeliveryId: string;
  createdAt: string;
};

export type ReplaySourceData =
  | { kind: "list"; deliveries: ReplaySourceDelivery[] }
  | { kind: "payload"; body: string; headers: Record<string, string> }
  | { kind: "error"; error: string };

const HEADER_DENYLIST = new Set([
  "content-type",
  "content-length",
  "host",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "connection",
  "cache-control",
  "pragma",
  "origin",
  "referer",
  "x-trigger-test",
]);

function isNoiseHeader(lower: string): boolean {
  return lower.startsWith("sec-") || HEADER_DENYLIST.has(lower);
}

function signatureHeaderNames(artifact: unknown): Set<string> {
  const names = new Set<string>();
  const parsed = WebhookVerifierArtifact.safeParse(artifact);
  if (!parsed.success || parsed.data.kind === "bundle") return names;
  const config = parsed.data.config;
  if (config.scheme === "hmac" || config.scheme === "asymmetric") {
    names.add(config.signatureHeader.toLowerCase());
    if (config.timestamp?.source.from === "header") {
      names.add(config.timestamp.source.name.toLowerCase());
    }
  }
  return names;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam, endpointParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) return typedjson({ kind: "error", error: "Project not found" } as ReplaySourceData);
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment)
    return typedjson({ kind: "error", error: "Environment not found" } as ReplaySourceData);

  if (!user.admin && !user.isImpersonating) {
    const org = await $replica.organization.findFirst({
      where: { id: project.organizationId },
      select: { featureFlags: true },
    });
    const enabled = await flag({
      key: FEATURE_FLAG.hasWebhooksAccess,
      defaultValue: false,
      overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
    });
    if (!enabled) return typedjson({ kind: "error", error: "Not found" } as ReplaySourceData);
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new WebhookDetailPresenter($replica, clickhouse);
  const endpoint = await presenter.findEndpoint({
    environmentId: environment.id,
    endpointFriendlyId: endpointParam,
  });
  if (!endpoint)
    return typedjson({ kind: "error", error: "Endpoint not found" } as ReplaySourceData);

  const repository = webhookDeliveriesRepository({ clickhouse, prisma: webhookReplica });

  const url = new URL(request.url);
  const deliveryId = url.searchParams.get("deliveryId") ?? undefined;

  if (deliveryId) {
    const delivery = await repository.getDelivery({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      friendlyId: deliveryId,
    });
    if (!delivery || delivery.webhookEndpointId !== endpoint.id) {
      return typedjson({ kind: "error", error: "Delivery not found" } as ReplaySourceData);
    }
    const body =
      delivery.parsedEvent != null ? JSON.stringify(delivery.parsedEvent, null, 2) : "{}";
    const strip = signatureHeaderNames(endpoint.verifierArtifact);
    const rawHeaders = (delivery.headers ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      const lower = key.toLowerCase();
      if (isNoiseHeader(lower) || strip.has(lower)) continue;
      if (typeof value === "string") headers[key] = value;
    }
    return typedjson({ kind: "payload", body, headers } as ReplaySourceData);
  }

  const { deliveries } = await repository.listDeliveries({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    webhookEndpointId: endpoint.id,
    page: { size: RECENT_DELIVERIES_LIMIT },
  });

  return typedjson({
    kind: "list",
    deliveries: deliveries.map((delivery) => ({
      friendlyId: delivery.friendlyId,
      status: delivery.status,
      isTest: delivery.isTest,
      externalDeliveryId: delivery.externalDeliveryId,
      createdAt: delivery.createdAt.toISOString(),
    })),
  } as ReplaySourceData);
}
