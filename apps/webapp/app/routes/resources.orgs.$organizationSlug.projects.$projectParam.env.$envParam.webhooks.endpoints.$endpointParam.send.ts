import { signWithVerifierConfig } from "@internal/webhook-engine";
import { type ActionFunctionArgs, redirect } from "@remix-run/server-runtime";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WebhookDetailPresenter } from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { requireUser } from "~/services/session.server";
import { webhookConsoleSendRateLimiter } from "~/services/webhookConsoleSendRateLimit.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

const ParamsSchema = EnvironmentParamSchema.extend({ endpointParam: z.string() });

const SigningSecretSchema = z.object({ secret: z.string() });

const SendSchema = z.object({
  body: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  signatureMode: z.enum(["signed", "unsigned", "tampered", "simulate"]).default("signed"),
  redirect: z.boolean().default(true),
});

export type WebhookSendResult =
  | {
      success: true;
      httpStatus: number;
      deliveryId?: string;
      deduplicated?: boolean;
      handshake?: boolean;
      responseBody: string;
    }
  | { success: false; error: string; notSignable?: boolean };

/**
 * Authenticated dashboard test-send. Session/cookie auth via requireUser; authorization via
 * findProjectBySlug (org membership) + findEnvironmentBySlug (env access) + the webhooks feature flag.
 * The delivery is injected in-process through the engine (verify -> filter -> route -> run), never by
 * looping back through the public ingress, so it does not consume the provider's ingress rate budget
 * and is not gated by WEBHOOK_INGRESS_ENABLED.
 */
export async function action({ request, params }: ActionFunctionArgs): Promise<WebhookSendResult> {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam, endpointParam } = ParamsSchema.parse(params);

  if (env.WEBHOOK_ENABLED !== "1") {
    return { success: false, error: "Webhooks are not enabled on this instance." };
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) return { success: false, error: "Project not found" };
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) return { success: false, error: "Environment not found" };

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
    if (!enabled) return { success: false, error: "Not found" };
  }

  const rateLimit = await webhookConsoleSendRateLimiter.limit(user.id);
  if (!rateLimit.success) {
    return { success: false, error: "Too many test sends. Wait a moment and try again." };
  }

  const parsed = SendSchema.safeParse(await request.json());
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { body, headers: providedHeaders, signatureMode, redirect: shouldRedirect } = parsed.data;

  const rawBody = new TextEncoder().encode(body);
  const limitBytes = env.WEBHOOK_INGRESS_BODY_SIZE_LIMIT_MB * 1024 * 1024;
  if (rawBody.length > limitBytes) {
    return {
      success: false,
      error: `Body exceeds the ${env.WEBHOOK_INGRESS_BODY_SIZE_LIMIT_MB} MB limit.`,
    };
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
  if (!endpoint) return { success: false, error: "Endpoint not found" };

  const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
  if (!verifier.success) return { success: false, error: "Endpoint has no verifier config" };
  if (verifier.data.kind === "bundle") {
    return { success: false, error: "Bundle verifiers cannot be sent from the console" };
  }
  const config = verifier.data.config;

  const ingressUrl = webhookIngressUrl(endpoint.opaqueId);
  const baseHeaders = { ...(providedHeaders ?? {}) };

  let ingestHeaders: Record<string, string> = baseHeaders;
  let ingestBody: Uint8Array = rawBody;
  let ingestUrl = ingressUrl;

  if (signatureMode === "signed") {
    if (!endpoint.hasSigningSecret) {
      return { success: false, error: "This endpoint has no signing secret. Set one first." };
    }
    const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });
    const stored = await secretStore.getSecret(
      SigningSecretSchema,
      `webhook:signing-secret:${endpoint.id}`
    );
    if (!stored?.secret) {
      return { success: false, error: "The signing secret could not be read." };
    }
    const signed = signWithVerifierConfig({
      config,
      secret: stored.secret,
      rawBody,
      url: ingressUrl,
      headers: baseHeaders,
    });
    if (!signed.ok) {
      return { success: false, error: signed.error, notSignable: signed.notSignable };
    }
    ingestHeaders = signed.headers;
    ingestBody = signed.body;
    ingestUrl = signed.url;
  } else if (signatureMode === "tampered") {
    const bogus = signWithVerifierConfig({
      config,
      secret: `tampered-${Date.now()}`,
      rawBody,
      url: ingressUrl,
      headers: baseHeaders,
    });
    if (bogus.ok) {
      ingestHeaders = bogus.headers;
      ingestBody = bogus.body;
      ingestUrl = bogus.url;
    } else if (config.scheme === "hmac" || config.scheme === "asymmetric") {
      ingestHeaders = { ...baseHeaders, [config.signatureHeader]: "deadbeef" };
    }
  }

  const finalHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...ingestHeaders,
    "x-trigger-test": "1",
  };

  const ingestInput = {
    opaqueId: endpoint.opaqueId,
    rawBytes: ingestBody,
    headers: finalHeaders,
    url: ingestUrl,
  };
  const result =
    signatureMode === "simulate"
      ? await webhookEngine.simulateInject(ingestInput)
      : await webhookEngine.ingest(ingestInput);

  const deliveryPathFor = (friendlyId: string) =>
    `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/webhooks/deliveries/${friendlyId}`;

  switch (result.outcome) {
    case "accepted": {
      const friendlyId = result.deliveryFriendlyId;
      if (shouldRedirect) throw redirect(deliveryPathFor(friendlyId));
      return {
        success: true,
        httpStatus: 200,
        deliveryId: friendlyId,
        responseBody: JSON.stringify({ received: true, deliveryId: friendlyId }),
      };
    }
    case "handshake":
      return { success: true, httpStatus: 200, handshake: true, responseBody: result.body };
    case "duplicate": {
      const friendlyId = result.deliveryId;
      if (shouldRedirect && friendlyId) throw redirect(deliveryPathFor(friendlyId));
      return {
        success: true,
        httpStatus: 200,
        deliveryId: friendlyId,
        deduplicated: true,
        responseBody: JSON.stringify({ received: true, deliveryId: friendlyId }),
      };
    }
    case "verification_failed":
      return {
        success: false,
        error: result.error ?? "Signature verification failed. No delivery was recorded.",
      };
    case "secret_missing":
      return { success: false, error: "This endpoint has no signing secret. Set one first." };
    case "endpoint_not_found":
    case "endpoint_inactive":
      return { success: false, error: "This endpoint is not active." };
    case "enqueue_failed":
      return { success: false, error: result.error ?? "Failed to record the delivery." };
    default:
      return { success: false, error: "The delivery could not be sent." };
  }
}
