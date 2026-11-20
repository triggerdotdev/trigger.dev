import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { randomBytes } from "node:crypto";
import { prisma, webhookPrisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";
import { webhookVerifyTokenKey } from "~/v3/webhookEngine.server";
import { StoredSigningSecret } from "~/v3/webhookSigningSecret";
import {
  clearWebhookSigningSecret,
  webhookSigningSecretKey,
} from "~/v3/webhookSigningSecret.server";
import { organizationHasWebhooksAccess } from "~/v3/webhooksAccess.server";
import type { McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool } from "./defineWrite.server";
import { quoteForPreview } from "./format/webhooks";
import { EndpointWriteInput } from "./schemas/webhooks";
import {
  WEBHOOKS_NOT_AVAILABLE,
  WEBHOOKS_NOT_ENABLED,
  webhooksAvailable,
  webhooksEngineEnabled,
} from "./webhooksRead.server";

const auth = { action: "write", subject: "webhooks" } as const;

type EndpointArgs = { endpointId: string };

export type WebhooksEndpointWriteDeps = { enabled: () => boolean };

const endpointSelect = {
  id: true,
  friendlyId: true,
  verifierArtifact: true,
  signingSecretKey: true,
  status: true,
  manuallyDeactivatedAt: true,
} as const;

type WritableEndpoint = {
  id: string;
  friendlyId: string;
  verifierArtifact: unknown;
  signingSecretKey: string | null;
  status: string;
  manuallyDeactivatedAt: Date | null;
};

const NO_GET_HANDSHAKE = "This endpoint's source does not verify its URL with a GET request.";

const isPaused = (e: WritableEndpoint) =>
  e.status === "INACTIVE" && e.manuallyDeactivatedAt !== null;
const isRunning = (e: WritableEndpoint) =>
  e.status === "ACTIVE" && e.manuallyDeactivatedAt === null;

const noOpText = (args: EndpointArgs, what: string) =>
  `Endpoint ${quoteForPreview(args.endpointId)} ${what}; nothing changed.`;

const refusals = {
  remove_webhook_secret: async (e: WritableEndpoint, a: EndpointArgs) => {
    if (e.signingSecretKey) return undefined;
    const leftover = await getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
      StoredSigningSecret,
      webhookSigningSecretKey(e.id)
    );
    return leftover ? undefined : noOpText(a, "has no signing secret");
  },
  generate_webhook_verify_token: (e: WritableEndpoint) => {
    const verifier = WebhookVerifierArtifact.safeParse(e.verifierArtifact);
    return verifier.success && "getHandshake" in verifier.data && verifier.data.getHandshake
      ? undefined
      : NO_GET_HANDSHAKE;
  },
  pause_webhook_endpoint: (e: WritableEndpoint, a: EndpointArgs) =>
    isPaused(e) ? noOpText(a, "is already paused") : undefined,
  resume_webhook_endpoint: (e: WritableEndpoint, a: EndpointArgs) =>
    isRunning(e) ? noOpText(a, "is not paused") : undefined,
};

async function findWritableEndpoint(
  input: EndpointArgs,
  ctx: McpToolContext,
  deps: WebhooksEndpointWriteDeps,
  tool: keyof typeof refusals
): Promise<{ endpoint: WritableEndpoint } | { error: McpToolResult }> {
  if (!deps.enabled()) return { error: errorResult(WEBHOOKS_NOT_ENABLED) };
  const environment = await resolveToolEnvironment(ctx);
  if (!environment) return { error: errorResult("Not authorized") };
  if (!(await webhooksAvailable(ctx))) return { error: errorResult(WEBHOOKS_NOT_AVAILABLE) };

  const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
    where: webhookEndpointLookup(environment.id, input.endpointId),
    select: endpointSelect,
  });
  if (!endpoint) return { error: errorResult("Webhook endpoint not found") };
  const refusal = await refusals[tool](endpoint, input);
  if (refusal) return { error: errorResult(refusal) };
  return { endpoint };
}

function withChecks(
  deps: WebhooksEndpointWriteDeps,
  tool: keyof typeof refusals,
  preview: (args: EndpointArgs) => string
) {
  return async (args: EndpointArgs, subject: McpSubject | null) => {
    if (!deps.enabled()) return { refuse: WEBHOOKS_NOT_ENABLED };
    if (!subject || !(await organizationHasWebhooksAccess(subject.organizationId))) {
      return { refuse: WEBHOOKS_NOT_AVAILABLE };
    }
    const endpoint =
      subject.environmentId &&
      (await webhookPrisma.webhookEndpoint.findFirst({
        where: webhookEndpointLookup(subject.environmentId, args.endpointId),
        select: endpointSelect,
      }));
    const refusal = endpoint ? await refusals[tool](endpoint, args) : undefined;
    return refusal ? { refuse: refusal } : preview(args);
  };
}

export function removeSecretPreview(args: EndpointArgs): string {
  return [
    `Remove the signing secret from webhook endpoint ${quoteForPreview(args.endpointId)}.`,
    "The stored secret is deleted, including a replaced secret that is still accepted during a rotation, and cannot be recovered.",
    "Until a new secret is set, every delivery to the endpoint is rejected and not recorded, so its subscribers get no runs and signed test sends fail.",
    "For a source that sends its own secret (such as Notion), the next secret the provider sends becomes the endpoint's secret.",
    "The endpoint's verification token is not changed.",
  ].join(" ");
}

export function verifyTokenPreview(args: EndpointArgs): string {
  return [
    `Generate a new verification token for webhook endpoint ${quoteForPreview(args.endpointId)} and show it once in the result.`,
    "It replaces the current token: the provider's URL verification (a GET request carrying the token) succeeds only with the new token from now on.",
    "Signing secrets and deliveries are not changed.",
  ].join(" ");
}

export function pausePreview(args: EndpointArgs): string {
  return [
    `Pause webhook endpoint ${quoteForPreview(args.endpointId)}.`,
    "Requests to its URL are answered 404 and not recorded, so events the provider sends while it is paused are lost unless the provider retries them after it is resumed.",
    "The provider's URL verification and test sends fail too.",
    "No new waiters can be created on it, and runs already waiting on it are not resumed by new events.",
    "Deliveries already accepted still run, and replays still work.",
    "A deploy does not resume it.",
  ].join(" ");
}

export function resumePreview(args: EndpointArgs): string {
  return [
    `Resume webhook endpoint ${quoteForPreview(args.endpointId)}.`,
    "Its URL accepts deliveries again and they trigger its subscribers.",
    "Events sent while it was paused are not recovered.",
    "This also reactivates an endpoint that is inactive because the current version no longer declares it: deliveries then go to the subscribers of the version that last declared it, and the next deploy that still leaves it out makes it inactive again.",
  ].join(" ");
}

export function createWebhooksEndpointWriteTools(
  deps: WebhooksEndpointWriteDeps
): McpToolDefinition[] {
  return [
    defineWriteTool({
      name: "remove_webhook_secret",
      title: "Remove Webhook Secret",
      description:
        "Remove a hosted webhook endpoint's signing secret. Every delivery is then rejected until a new secret is set with set_webhook_secret or generate_webhook_secret; a source that sends its own secret (such as Notion) adopts the next one it sends. Use this when a secret leaked and the provider must be reconnected.",
      shape: EndpointWriteInput.shape,
      approval: "required",
      auth,
      confirm: { preview: withChecks(deps, "remove_webhook_secret", removeSecretPreview) },
      run: async (input, ctx) => {
        const found = await findWritableEndpoint(input, ctx, deps, "remove_webhook_secret");
        if ("error" in found) return found.error;

        await clearWebhookSigningSecret(found.endpoint.id);
        return textResult(
          `Removed the signing secret from ${found.endpoint.friendlyId}. Deliveries to it are rejected until a new secret is set.`
        );
      },
    }),
    defineWriteTool({
      name: "generate_webhook_verify_token",
      title: "Generate Webhook Verify Token",
      description:
        "Generate a new verification token for a hosted webhook endpoint whose source verifies its URL with a GET request (such as Meta's hub.verify_token), and return it once. It replaces the current token. Give it to the provider and never print, log or commit it.",
      shape: EndpointWriteInput.shape,
      approval: "required",
      auth,
      confirm: { preview: withChecks(deps, "generate_webhook_verify_token", verifyTokenPreview) },
      run: async (input, ctx) => {
        const found = await findWritableEndpoint(input, ctx, deps, "generate_webhook_verify_token");
        if ("error" in found) return found.error;

        const token = `whvt_${randomBytes(24).toString("hex")}`;
        await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret(
          webhookVerifyTokenKey(found.endpoint.id),
          { token }
        );
        return textResult(
          `Generated a new verification token for ${found.endpoint.friendlyId}. It is shown once; give it to the provider and don't print, log or commit it.\n\n${token}`
        );
      },
    }),
    defineWriteTool({
      name: "pause_webhook_endpoint",
      title: "Pause Webhook Endpoint",
      description:
        "Pause a hosted webhook endpoint. Its URL answers 404 and records nothing, so events the provider sends meanwhile are lost unless it retries them; deliveries already accepted still run. A deploy does not resume it; use resume_webhook_endpoint.",
      shape: EndpointWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: withChecks(deps, "pause_webhook_endpoint", pausePreview) },
      run: async (input, ctx) => {
        const found = await findWritableEndpoint(input, ctx, deps, "pause_webhook_endpoint");
        if ("error" in found) return found.error;

        await webhookPrisma.webhookEndpoint.update({
          where: { id: found.endpoint.id },
          data: { status: "INACTIVE", manuallyDeactivatedAt: new Date() },
        });
        return textResult(`Paused ${found.endpoint.friendlyId}.`);
      },
    }),
    defineWriteTool({
      name: "resume_webhook_endpoint",
      title: "Resume Webhook Endpoint",
      description:
        "Resume a paused hosted webhook endpoint so its URL accepts deliveries again. Events sent while it was paused are not recovered.",
      shape: EndpointWriteInput.shape,
      approval: "configurable",
      auth,
      confirm: { preview: withChecks(deps, "resume_webhook_endpoint", resumePreview) },
      run: async (input, ctx) => {
        const found = await findWritableEndpoint(input, ctx, deps, "resume_webhook_endpoint");
        if ("error" in found) return found.error;

        await webhookPrisma.webhookEndpoint.update({
          where: { id: found.endpoint.id },
          data: { status: "ACTIVE", manuallyDeactivatedAt: null },
        });
        return textResult(`Resumed ${found.endpoint.friendlyId}.`);
      },
    }),
  ];
}

export const webhooksEndpointWriteTools = createWebhooksEndpointWriteTools({
  enabled: webhooksEngineEnabled,
});
