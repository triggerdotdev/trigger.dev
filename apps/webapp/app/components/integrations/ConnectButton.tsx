import type { ServiceMetadata } from "@trigger.dev/integration-sdk";
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
  integration: ServiceMetadata;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
  children: (status: Status) => React.ReactNode;
  className?: string;
}) {
  const authentication = Object.values(integration.authentication)[0];
  switch (authentication.type) {
    case "oauth2":
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
          authentication={authentication}
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
  integration: ServiceMetadata;
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
