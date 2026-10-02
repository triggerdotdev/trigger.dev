import {
  discordVerifierConfig,
  stripeVerifierConfig,
  webhookSetupPrompts,
} from "@trigger.dev/core/webhooks";
import { describe, expect, it } from "vitest";
import { renderWebhookSetupPrompt, type WebhookSetupPromptEndpoint } from "~/v3/webhookSetupPrompt";

const context = {
  webhookUrl: "https://hooks.example.test/webhooks/v1/ingest/op_1",
  apiOrigin: "https://api.example.test",
  dashboardUrl: "https://app.example.test/orgs/o/projects/p/env/dev/webhooks/endpoints/wh_1",
  projectRef: "proj_abc",
  environment: "dev",
};

function endpoint(overrides: Partial<WebhookSetupPromptEndpoint> = {}): WebhookSetupPromptEndpoint {
  return {
    friendlyId: "wh_1",
    declaredId: "payments",
    source: "stripe",
    secretProvisioning: "provider",
    hasSigningSecret: false,
    setupPrompt: webhookSetupPrompts.stripe ?? null,
    tenantId: null,
    routingTargets: [
      {
        type: "task",
        id: "orders",
        taskId: "orders",
        filter: "event.type == 'checkout.session.completed'",
      },
      {
        type: "session",
        id: "support:events",
        taskIdentifier: "support",
        keyTemplate: "{body.customer}",
        deliverAs: "action",
      },
    ],
    verifierArtifact: { kind: "preset", preset: "stripe", config: stripeVerifierConfig() },
    ...overrides,
  };
}

describe("renderWebhookSetupPrompt", () => {
  it("gives the URL, each subscriber's filter and the source's own instructions", () => {
    const prompt = renderWebhookSetupPrompt(endpoint(), context);

    expect(prompt).toContain(`Webhook URL: ${context.webhookUrl}`);
    expect(prompt).toContain(
      "- orders (task orders): `event.type == 'checkout.session.completed'`"
    );
    expect(prompt).toContain("- support:events (agent support): every event");
    expect(prompt).toContain("stripe webhook_endpoints create");
    expect(prompt).toContain('projectRef "proj_abc", environment "dev", endpointId "wh_1"');
    expect(prompt).toContain("PUT https://api.example.test/api/v1/webhooks/endpoints/wh_1/secret");
    expect(prompt).toContain("Signing secret: not set");
  });

  it("stores a provider-issued secret and generates an integrator-chosen one", () => {
    expect(renderWebhookSetupPrompt(endpoint(), context)).toContain(
      "stripe issues the signing secret when you create the webhook. Store it with `set_webhook_secret`."
    );

    const github = renderWebhookSetupPrompt(
      endpoint({ source: "github", secretProvisioning: "integrator", setupPrompt: null }),
      context
    );
    expect(github).toContain("Generate one with `generate_webhook_secret`");
    expect(github).not.toContain("Store it with `set_webhook_secret`");
    expect(github).toContain("Find where github lets you add a webhook.");
  });

  it("asks for the public key on an asymmetric source and warns before replacing a set secret", () => {
    const prompt = renderWebhookSetupPrompt(
      endpoint({
        source: "discord",
        hasSigningSecret: true,
        verifierArtifact: { kind: "preset", preset: "discord", config: discordVerifierConfig() },
      }),
      context
    );

    expect(prompt).toContain("Public key: set");
    expect(prompt).toContain("Copy its public key and store it with `set_webhook_secret`.");
    expect(prompt).toContain("A public key is already set; replacing it breaks deliveries");
  });

  it("asks which events to send when nothing subscribes yet", () => {
    const prompt = renderWebhookSetupPrompt(endpoint({ routingTargets: [] }), context);

    expect(prompt).toContain("Nothing subscribes to this endpoint yet");
  });
});
