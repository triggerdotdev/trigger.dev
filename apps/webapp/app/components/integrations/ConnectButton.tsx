import { useCallback, useEffect } from "react";
import Pizzly from "@nangohq/pizzly-frontend";
import { useFetcher } from "@remix-run/react";
import type {
  CreateResponse,
  Update,
  UpdateResponse,
} from "~/routes/resources/connection";
import type { CatalogIntegration } from "internal-catalog";
import { IntegrationIcon } from "./IntegrationIcon";

const actionPath = "/resources/connection";

export function ConnectButton({
  integration,
  organizationId,
  sourceId,
  serviceId,
  className,
  children,
}: {
  integration: CatalogIntegration;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
  className?: string;
  children: (status: Status) => React.ReactNode;
}) {
  const { createFetcher, status } = useCreateConnection(sourceId, serviceId);

  return (
    <createFetcher.Form method="post" action={actionPath}>
      <input type="hidden" name="type" value="create" />
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="key" value={integration.slug} />
      <button
        type="submit"
        disabled={status === "loading"}
        className={className}
      >
        {children(status)}
      </button>
    </createFetcher.Form>
  );
}

export function BasicConnectButton({
  integration,
  organizationId,
  sourceId,
  serviceId,
}: {
  integration: CatalogIntegration;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
}) {
  return (
    <ConnectButton
      key={integration.slug}
      integration={integration}
      organizationId={organizationId}
      sourceId={sourceId}
      serviceId={serviceId}
      className="flex rounded-md bg-blue-600 gap-3 text-sm text-white items-center hover:bg-blue-700 transition shadow-md disabled:opacity-50 py-2 pl-2 pr-3"
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

export type Status = "loading" | "idle";

export function useCreateConnection(sourceId?: string, serviceId?: string) {
  const createConnectionFetcher = useFetcher<CreateResponse>();
  const completeConnectionFetcher = useFetcher<UpdateResponse>();
  const status: Status =
    createConnectionFetcher.state === "idle" &&
    completeConnectionFetcher.state === "idle"
      ? "idle"
      : "loading";

  const completeFlow = useCallback(
    async ({
      pizzlyHost,
      connectionId,
      service,
      sourceId,
      serviceId,
    }: {
      pizzlyHost: string;
      connectionId: string;
      service: string;
      sourceId?: string;
      serviceId?: string;
    }) => {
      try {
        const pizzly = new Pizzly(pizzlyHost);
        await pizzly.auth(service, connectionId);

        let completeData: Update = {
          type: "update",
          connectionId: connectionId,
        };

        if (sourceId) {
          completeData = {
            ...completeData,
            sourceId,
          };
        }

        if (serviceId) {
          completeData = {
            ...completeData,
            serviceId,
          };
        }

        completeConnectionFetcher.submit(completeData, {
          method: "post",
          action: actionPath,
        });
      } catch (error: any) {
        console.error(
          `There was an error in the OAuth flow for integration "${error.providerConfigKey}" and connection-id "${error.connectionId}": ${error.error.type} - ${error.error.message}`,
          error
        );
      }
    },
    [completeConnectionFetcher]
  );

  useEffect(() => {
    if (
      createConnectionFetcher.state !== "idle" ||
      createConnectionFetcher.type !== "done"
    )
      return;
    if (
      completeConnectionFetcher.state !== "idle" ||
      completeConnectionFetcher.type !== "init"
    )
      return;
    if (createConnectionFetcher.data === undefined) return;

    completeConnectionFetcher.type = "init";

    completeFlow({
      pizzlyHost: createConnectionFetcher.data.host,
      connectionId: createConnectionFetcher.data.connectionId,
      service: createConnectionFetcher.data.integrationKey,
      sourceId,
      serviceId,
    });
  }, [
    completeConnectionFetcher,
    completeConnectionFetcher.data,
    completeConnectionFetcher.submit,
    completeFlow,
    createConnectionFetcher,
    serviceId,
    sourceId,
  ]);

  return {
    createFetcher: createConnectionFetcher,
    status,
  };
}
