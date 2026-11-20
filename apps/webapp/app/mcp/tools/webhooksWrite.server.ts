import { WebhookPreviousSecretTtlSeconds } from "@trigger.dev/core/v3";
import { z } from "zod";
import { webhookPrisma, webhookReplica } from "~/db.server";
import { env as serverEnv } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";
import { webhookEngine } from "~/v3/webhookEngine.server";
import {
  generateWebhookSigningSecret,
  storeWebhookSigningSecret,
} from "~/v3/webhookSigningSecret.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import { DeliveryInput, EndpointInput } from "./schemas/webhooks";

const auth = { action: "write", subject: "webhooks" } as const;

const ReplayInput = DeliveryInput.extend({
  targetId: z
    .string()
    .describe(
      "Replay to only this subscriber (its id on the endpoint, from the delivery's targets), even if its filter skipped the event. Omit to replay to every subscriber, re-checking their filters."
    )
    .optional(),
});

const PreviousSecretTtlInput = WebhookPreviousSecretTtlSeconds.optional().describe(
  "Keep accepting the replaced secret for this many seconds (at most 604800, 7 days) so deliveries the provider still signs with it keep verifying. Omit or pass 0 to replace it immediately, for example when it leaked."
);

const GenerateSecretInput = EndpointInput.extend({
  previousSecretTtlSeconds: PreviousSecretTtlInput,
});

const SetSecretInput = EndpointInput.extend({
  secret: z.string().min(1).describe("The signing secret or public key the provider issued"),
  previousSecretTtlSeconds: PreviousSecretTtlInput,
});

function previousSecretNote(expiresAt: string | undefined): string {
  return expiresAt ? ` The previous secret keeps verifying deliveries until ${expiresAt}.` : "";
}

const findEndpoint = (environmentId: string, endpointId: string) =>
  webhookPrisma.webhookEndpoint.findFirst({
    where: webhookEndpointLookup(environmentId, endpointId),
    select: { id: true, friendlyId: true, verifierArtifact: true },
  });

export const webhooksWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "replay_webhook_delivery",
    title: "Replay Webhook Delivery",
    description:
      "Replay a webhook delivery from its stored event as a new delivery. With no targetId it goes to every subscriber again, re-checking their filters; with targetId it goes to that one subscriber even if its filter skipped the event. Replays trigger real runs, so confirm with the user first.",
    shape: ReplayInput.shape,
    approval: "required",
    auth,
    run: async (input, ctx) => {
      if (serverEnv.WEBHOOK_ENABLED !== "1") return errorResult("Not found");
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");
      const { ability } = ctx;
      if (!ability) return fencedError("Not authorized", "webhook-replay-error");
      const envType = environment.type;

      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        environment.organizationId,
        "standard"
      );
      const original = await webhookDeliveriesRepository({
        clickhouse,
        prisma: webhookReplica,
      }).getDelivery({
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        environmentId: environment.id,
        friendlyId: input.deliveryId,
      });
      if (!original) return errorResult("Webhook delivery not found");

      const result = await webhookEngine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        targetId: input.targetId || undefined,
        authorize: (subscribers) =>
          subscribers.flatMap((subscriber) => {
            if (!ability.can("trigger", { type: "tasks", id: subscriber.taskId, envType })) {
              return [subscriber.taskId];
            }
            if (
              subscriber.type === "session" &&
              !ability.can("write", { type: "sessions", envType })
            ) {
              return [`sessions (for ${subscriber.id})`];
            }
            return [];
          }),
      });

      switch (result.outcome) {
        case "forbidden":
          return errorResult(
            `Replaying this delivery needs permissions you don't have: ${[...new Set(result.denied)].join(", ")}`
          );
        case "replayed":
          return textResult(
            `Replayed ${input.deliveryId}${input.targetId ? ` to ${input.targetId}` : ""} as ${result.deliveryFriendlyId}. Call get_webhook_delivery with ${result.deliveryFriendlyId} once it has processed to see where it went.`
          );
        case "target_not_found":
          return errorResult(`The endpoint has no subscriber "${input.targetId}".`);
        case "queue_full":
          return errorResult(
            "This environment has too many webhook deliveries waiting. Try again later."
          );
        default:
          return errorResult("Webhook delivery not found");
      }
    },
  }),
  defineWriteTool({
    name: "generate_webhook_secret",
    title: "Generate Webhook Secret",
    description:
      "Generate a new signing secret for a hosted webhook endpoint and return it once, for providers where you choose the secret (for example GitHub). It replaces the existing secret; pass previousSecretTtlSeconds to keep accepting the old one while you update the provider, otherwise deliveries signed with it fail. Never print, log or commit the returned secret. The returned secret enters your context. To keep it out, run the CLI instead: `npx trigger.dev@latest webhooks generate-secret <endpoint> --env <env> --to-env <NAME>` saves it to .env.local without printing it, so you can pass it to the provider by variable name, or `--print` pipes it straight into the provider's CLI. When the endpoint already has a secret, add `--previous-secret-ttl` (for example 24h, or 0 if the old secret leaked). Prefer the CLI whenever you can run shell commands.",
    shape: GenerateSecretInput.shape,
    approval: "required",
    auth,
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const endpoint = await findEndpoint(environment.id, input.endpointId);
      if (!endpoint) return errorResult("Webhook endpoint not found");

      const result = await generateWebhookSigningSecret(endpoint, {
        previousSecretTtlSeconds: input.previousSecretTtlSeconds,
      });
      if (!result.ok) return errorResult(result.error);

      return textResult(
        `Generated a new signing secret for ${endpoint.friendlyId}. It is shown once; give it to the provider and don't print, log or commit it.${previousSecretNote(result.previousSecretExpiresAt)}\n\n${result.secret}`
      );
    },
  }),
  {
    ...defineReadTool({
      name: "set_webhook_secret",
      title: "Set Webhook Secret",
      description:
        "Store the signing secret (or public key) a provider issued for a hosted webhook endpoint, for example the whsec_ secret Stripe returns when a webhook endpoint is created. It replaces the existing secret; pass previousSecretTtlSeconds to keep accepting the old one for a while. The secret you pass here enters your context. To keep it out, run the CLI instead, which never prints it: pipe it from the provider's CLI (`<provider command> | npx trigger.dev@latest webhooks set-secret <endpoint> --env <env>`), or read it from an environment variable or the project's .env files (`webhooks set-secret <endpoint> --env <env> --from-env STRIPE_WEBHOOK_SECRET`). When the endpoint already has a secret, add `--previous-secret-ttl` (for example 24h, or 0 if the old secret leaked). Prefer the CLI whenever you can run shell commands.",
      shape: SetSecretInput.shape,
      auth: {
        ...auth,
        confirm: {
          preview: (args) =>
            `set_webhook_secret ${JSON.stringify({ ...(args as object), secret: "[redacted]" })}`,
        },
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Not authorized");

        const endpoint = await findEndpoint(environment.id, input.endpointId);
        if (!endpoint) return errorResult("Webhook endpoint not found");

        const { previousSecretExpiresAt } = await storeWebhookSigningSecret(
          endpoint,
          input.secret,
          {
            previousSecretTtlSeconds: input.previousSecretTtlSeconds,
          }
        );

        return textResult(
          `Stored the signing secret for ${endpoint.friendlyId}.${previousSecretNote(previousSecretExpiresAt)}`
        );
      },
    }),
    annotations: { title: "Set Webhook Secret", readOnlyHint: false, destructiveHint: true },
    approval: "required",
  },
];
