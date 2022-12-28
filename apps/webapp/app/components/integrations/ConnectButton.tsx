import githubLogo from "~/assets/images/integrations/logo-github.png";
import { useCallback, useEffect } from "react";
import Pizzly from "@nangohq/pizzly-frontend";
import { useFetcher } from "@remix-run/react";
import type {
  CreateResponse,
  Update,
  UpdateResponse,
} from "~/routes/resources/connection";

export type Integration = {
  key: string;
  name: string;
  logo: string;
};

export const integrations: Integration[] = [
  {
    key: "github",
    name: "GitHub",
    logo: githubLogo,
  },
];

const actionPath = "/resources/connection";

export function ConnectButton({
  integration,
  organizationId,
  sourceId,
  className,
  children,
}: {
  integration: Integration;
  organizationId: string;
  sourceId?: string;
  className?: string;
  children: (status: Status) => React.ReactNode;
}) {
  const { createFetcher, status } = useCreateConnection(sourceId);

  return (
    <createFetcher.Form method="post" action={actionPath}>
      <input type="hidden" name="type" value="create" />
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="key" value={integration.key} />
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

type Status = "loading" | "idle";

export function useCreateConnection(sourceId?: string) {
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
    }: {
      pizzlyHost: string;
      connectionId: string;
      service: string;
      sourceId?: string;
    }) => {
      console.log(`completeFlow`, {
        pizzlyHost,
        connectionId,
        service,
        sourceId,
      });

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
    });
  }, [
    completeConnectionFetcher,
    completeConnectionFetcher.data,
    completeConnectionFetcher.submit,
    completeFlow,
    createConnectionFetcher,
    sourceId,
  ]);

  return {
    createFetcher: createConnectionFetcher,
    status,
  };
}
