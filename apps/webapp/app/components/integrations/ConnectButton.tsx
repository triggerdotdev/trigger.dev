import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import { AddApiKeyButton } from "./AddApiKeyButton";
import { ConnectOAuthButton } from "./ConnectOAuthButton";
import { IntegrationIcon } from "./IntegrationIcon";

export type Status = "loading" | "idle";

export function ConnectButton({
  integration,
  organizationId,
  sourceId,
  serviceId,
  children,
  className,
}: {
  integration: IntegrationMetadata;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
  children: (status: Status) => React.ReactNode;
  className?: string;
}) {
  switch (integration.authentication.type) {
    case "oauth":
      return (
        <ConnectOAuthButton
          integration={integration}
          organizationId={organizationId}
          sourceId={sourceId}
          serviceId={serviceId}
          children={children}
          className={className}
        />
      );
    case "api_key":
      return (
        <AddApiKeyButton
          integration={integration}
          authentication={integration.authentication}
          organizationId={organizationId}
          sourceId={sourceId}
          serviceId={serviceId}
          children={children}
          className={className}
        />
      );
    default:
      throw new Error("Unsupported authentication type");
  }
}

export function BasicConnectButton({
  integration,
  organizationId,
  sourceId,
  serviceId,
}: {
  integration: IntegrationMetadata;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
}) {
  return (
    <ConnectButton
      integration={integration}
      organizationId={organizationId}
      sourceId={sourceId}
      serviceId={serviceId}
      className="flex items-center gap-3 rounded bg-indigo-700 py-2 pl-3 pr-4 text-sm text-white shadow-md transition hover:bg-indigo-600 disabled:opacity-50"
    >
      {(status) => (
        <>
          <IntegrationIcon integration={integration} />
          {status === "loading" ? (
            <span className="">Connecting…</span>
          ) : (
            <span>Connect to {integration.name}</span>
          )}
        </>
      )}
    </ConnectButton>
  );
}
