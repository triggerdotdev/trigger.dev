import { type WebhookHandshakeConfig, WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";

export type WebhookComposerEndpointData = {
  friendlyId: string;
  label: string;
  source: string;
  ingressUrl: string;
  scheme: "hmac" | "shared-secret" | "url-secret" | "asymmetric";
  hasSigningSecret: boolean;
  /** Present only when the endpoint declares a provider handshake (unlocks the handshake test). */
  handshake: WebhookHandshakeConfig | null;
};

type EndpointRow = {
  friendlyId: string;
  opaqueId: string;
  source: string;
  endpointTenantId: string;
  endpointExternalRef: string;
  verifierArtifact: unknown;
  signingSecretKey: string | null;
};

/**
 * Map raw WebhookEndpoint rows to the shape the composer consumes (label + scheme + ingress URL +
 * handshake). Shared by the /test WEBHOOK arm and the console tab so the two stay in lockstep.
 */
export function buildWebhookComposerEndpoints(rows: EndpointRow[]): WebhookComposerEndpointData[] {
  return rows.map((endpoint) => {
    const parsed = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
    const scheme =
      parsed.success && parsed.data.kind !== "bundle" ? parsed.data.config.scheme : "hmac";
    const handshake =
      parsed.success && parsed.data.kind !== "bundle" ? (parsed.data.handshake ?? null) : null;

    const isDefault = endpoint.endpointTenantId === "" && endpoint.endpointExternalRef === "";

    return {
      friendlyId: endpoint.friendlyId,
      label: isDefault
        ? "default"
        : endpoint.endpointExternalRef
          ? `${endpoint.endpointTenantId}: ${endpoint.endpointExternalRef}`
          : endpoint.endpointTenantId,
      source: endpoint.source,
      ingressUrl: webhookIngressUrl(endpoint.opaqueId),
      scheme,
      hasSigningSecret: endpoint.signingSecretKey != null && endpoint.signingSecretKey !== "",
      handshake,
    } satisfies WebhookComposerEndpointData;
  });
}
