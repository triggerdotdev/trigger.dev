import githubLogo from "~/assets/images/integrations/logo-github.png";
import { useEffect } from "react";
import Pizzly from "@nangohq/pizzly-frontend";
import { useFetcher } from "@remix-run/react";
import { PlusCircleIcon } from "@heroicons/react/24/solid";
import type {
  CreateResponse,
  UpdateResponse,
} from "~/routes/api/v1/internal/connection";

type Integration = {
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

const actionPath = "/api/v1/internal/connection";

export function ConnectButton({
  integration,
  organizationId,
  className,
  children,
}: {
  integration: Integration;
  organizationId: string;
  className?: string;
  children: (status: Status) => React.ReactNode;
}) {
  const { createFetcher, status } = useCreateConnection();

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

export function useCreateConnection() {
  const createConnectionFetcher = useFetcher<CreateResponse>();
  const completeConnectionFetcher = useFetcher<UpdateResponse>();
  const status: Status =
    createConnectionFetcher.state === "loading" ||
    completeConnectionFetcher.state === "loading"
      ? "loading"
      : "idle";

  useEffect(() => {
    async function authenticationFlow() {
      if (createConnectionFetcher.data === undefined) return;

      try {
        const pizzly = new Pizzly(createConnectionFetcher.data.host);

        await pizzly.auth(
          createConnectionFetcher.data.integrationKey,
          createConnectionFetcher.data.connectionId
        );

        completeConnectionFetcher.submit(
          {
            type: "update",
            connectionId: createConnectionFetcher.data.connectionId,
          },
          { method: "post", action: actionPath }
        );
      } catch (error: any) {
        console.error(
          `There was an error in the OAuth flow for integration "${error.providerConfigKey}" and connection-id "${error.connectionId}": ${error.error.type} - ${error.error.message}`
        );
      }
    }

    authenticationFlow();
  }, [completeConnectionFetcher, createConnectionFetcher.data]);

  return {
    createFetcher: createConnectionFetcher,
    status,
  };
}
