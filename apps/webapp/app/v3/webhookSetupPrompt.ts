import {
  WebhookRoutingTarget,
  WebhookVerifierArtifact,
  type WebhookEndpointSubscriberObject,
} from "@trigger.dev/core/v3";

export type WebhookSetupPromptEndpoint = {
  friendlyId: string;
  declaredId: string;
  source: string;
  secretProvisioning: string;
  hasSigningSecret: boolean;
  setupPrompt: string | null;
  tenantId: string | null;
  routingTargets: unknown;
  verifierArtifact: unknown;
};

export type WebhookSetupPromptContext = {
  webhookUrl: string;
  apiOrigin: string;
  dashboardUrl: string;
  projectRef: string;
  /** The MCP tools' environment name: dev, staging, prod or preview. */
  environment: string;
  branch?: string;
};

/** How the dashboard names a subscriber: a webhook() task, an agent's chat.event, or a channel. */
export function webhookSubscriberKind(target: WebhookRoutingTarget): string {
  if (target.type === "task") return "Task";
  return target.deliverAs === "message" ? "Channel" : "Agent event";
}

export function webhookEndpointSubscribers(
  routingTargets: unknown
): WebhookEndpointSubscriberObject[] {
  const targets = Array.isArray(routingTargets) ? routingTargets : [];
  return targets.flatMap((target) => {
    const parsed = WebhookRoutingTarget.safeParse(target);
    if (!parsed.success) return [];
    const subscriber = parsed.data;
    return [
      {
        id: subscriber.id,
        type: subscriber.type,
        taskId: subscriber.type === "task" ? subscriber.taskId : subscriber.taskIdentifier,
        filter: subscriber.filter ?? null,
      },
    ];
  });
}

export function mcpEnvironmentName(type: string): string {
  switch (type) {
    case "DEVELOPMENT":
      return "dev";
    case "STAGING":
      return "staging";
    case "PREVIEW":
      return "preview";
    default:
      return "prod";
  }
}

/**
 * The prompt a user hands an AI agent to register an endpoint with its provider. The source's own
 * `setupPrompt` supplies the provider steps; this wraps it with the URL, the subscribers' filters (so
 * the agent subscribes to the right events) and how to generate or store the signing secret.
 */
export function renderWebhookSetupPrompt(
  endpoint: WebhookSetupPromptEndpoint,
  context: WebhookSetupPromptContext
): string {
  const source = endpoint.source;
  const subscribers = webhookEndpointSubscribers(endpoint.routingTargets);
  const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
  const asymmetric =
    verifier.success && "config" in verifier.data && verifier.data.config.scheme === "asymmetric";
  const environmentArgs = `projectRef "${context.projectRef}", environment "${context.environment}"${
    context.branch ? `, branch "${context.branch}"` : ""
  }`;
  const apiBase = `${context.apiOrigin}/api/v1/webhooks/endpoints/${endpoint.friendlyId}`;

  const lines: string[] = [
    `Register a Trigger.dev webhook endpoint with ${source}.`,
    "",
    `A Trigger.dev project (${context.projectRef}) receives ${source} webhooks on a hosted endpoint in its ${context.environment} environment. Register the endpoint's URL with ${source}, then make sure Trigger.dev has the signing secret so deliveries verify.`,
    "",
    "## Endpoint",
    "",
    `- Endpoint id: ${endpoint.friendlyId}`,
    `- Declared as: ${endpoint.declaredId}${endpoint.tenantId ? ` (tenant ${endpoint.tenantId})` : ""}`,
    `- Webhook URL: ${context.webhookUrl}`,
    `- ${asymmetric ? "Public key" : "Signing secret"}: ${
      endpoint.hasSigningSecret ? "set" : "not set, so every delivery is rejected until it is"
    }`,
    `- Dashboard: ${context.dashboardUrl}`,
    "",
    "## Subscribers",
    "",
  ];

  if (subscribers.length === 0) {
    lines.push(
      `Nothing subscribes to this endpoint yet, so deliveries are recorded but not routed. Ask the user which ${source} events they want.`
    );
  } else {
    lines.push(
      `Subscribe ${source} to the events these need. A subscriber's filter shows which events it accepts.`,
      ""
    );
    for (const subscriber of subscribers) {
      const kind =
        subscriber.type === "task" ? `task ${subscriber.taskId}` : `agent ${subscriber.taskId}`;
      lines.push(
        `- ${subscriber.id} (${kind}): ${subscriber.filter ? `\`${subscriber.filter}\`` : "every event"}`
      );
    }
  }

  lines.push(
    "",
    "## Steps",
    "",
    `1. Register the webhook URL with ${source}, following the ${source} instructions below.`,
    `2. ${secretStep(endpoint, asymmetric)}`,
    `3. Call \`get_webhook_endpoint_details\` and check that \`secretSet\` is true. If ${source} can send a test event, send one and confirm it shows up on the dashboard page above.`,
    "",
    "Treat the signing secret as a credential: pass it straight to the tool or API, and never print it, log it, write it to a file or commit it.",
    "",
    "## Trigger.dev tools",
    "",
    `The tools above come from the Trigger.dev MCP server (install it with \`npx trigger.dev@latest install-mcp\`). Call them with ${environmentArgs}, endpointId "${endpoint.friendlyId}".`,
    "",
    "Without the MCP server, use the REST API with the environment's secret key (TRIGGER_SECRET_KEY) as a Bearer token:",
    "",
    `- Read the endpoint: GET ${apiBase}`,
    `- Generate a secret, returned once: POST ${apiBase}/rotate-secret`,
    `- Store a secret: PUT ${apiBase}/secret with the JSON body {"secret": "..."}`,
    "",
    `## ${source} instructions`,
    "",
    endpoint.setupPrompt?.trim() ||
      `Find where ${source} lets you add a webhook. Prefer its CLI or API when you have access; otherwise tell the user exactly where to go in its dashboard. Use the webhook URL above as the destination, and choose JSON if ${source} asks for a content type.`
  );

  return lines.join("\n");
}

function secretStep(endpoint: WebhookSetupPromptEndpoint, asymmetric: boolean): string {
  const source = endpoint.source;
  const replacing = endpoint.hasSigningSecret
    ? ` ${asymmetric ? "A public key" : "A secret"} is already set; replacing it breaks deliveries until ${source} uses the new one, so only replace it when you're creating or updating the webhook in ${source}.`
    : "";

  if (asymmetric) {
    return `${source} signs deliveries with a key pair. Copy its public key and store it with \`set_webhook_secret\`.${replacing}`;
  }

  switch (endpoint.secretProvisioning) {
    case "provider":
      return `${source} issues the signing secret when you create the webhook. Store it with \`set_webhook_secret\`.${replacing}`;
    case "integrator":
      return `You choose the signing secret. Generate one with \`generate_webhook_secret\`, which returns it once, and give it to ${source} when you create the webhook.${replacing}`;
    default:
      return `If ${source} issues a signing secret, store it with \`set_webhook_secret\`. Otherwise generate one with \`generate_webhook_secret\`, which returns it once, and give it to ${source}.${replacing}`;
  }
}
