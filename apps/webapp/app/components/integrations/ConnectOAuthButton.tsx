import Pizzly from "@nangohq/pizzly-frontend";
import { useFetcher } from "@remix-run/react";
import type { Provider } from "@trigger.dev/providers";
import { useCallback, useEffect } from "react";
import invariant from "tiny-invariant";
import type { Response as CreateResponse } from "~/routes/resources/connection";
import type {
  Request as UpdateRequest,
  Response as UpdateResponse,
} from "~/routes/resources/connection/$connectionId";
import type { Status } from "./ConnectButton";

export function ConnectOAuthButton({
  integration,
  organizationId,
  sourceId,
  serviceId,
  className,
  children,
}: {
  integration: Provider;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
  className?: string;
  children: (status: Status) => React.ReactNode;
}) {
  const { createFetcher, status } = useCreateConnection(sourceId, serviceId);

  return (
    <createFetcher.Form method="post" action="/resources/connection?index">
      <input type="hidden" name="type" value="oauth" />
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="service" value={integration.slug} />
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

        let completeData: UpdateRequest = {
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
          method: "put",
          action: `/resources/connection/${connectionId}`,
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

    if (!createConnectionFetcher.data.success) {
      throw new Error(
        `There was an error creating the connection: ${createConnectionFetcher.data.errors}`
      );
    }

    invariant(
      createConnectionFetcher.data.pizzlyHost,
      "pizzlyHost is required for oauth"
    );

    completeFlow({
      pizzlyHost: createConnectionFetcher.data.pizzlyHost,
      connectionId: createConnectionFetcher.data.connectionId,
      service: createConnectionFetcher.data.service,
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
