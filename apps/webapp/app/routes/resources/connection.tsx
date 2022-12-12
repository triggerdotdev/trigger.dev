import githubLogo from "../../assets/images/integrations/github.png";
import { useCallback, useEffect } from "react";
import Pizzly from "@nangohq/pizzly-frontend";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { env } from "~/env.server";
import { z } from "zod";
import { createAPIConnection } from "~/models/apiConnection.server";
import { APIConnectionType } from ".prisma/client";
import { useFetcher } from "@remix-run/react";

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

const createSchema = z.object({
  type: z.literal("create"),
  organizationId: z.string(),
  key: z.string(),
});

const updateSchema = z.object({
  type: z.literal("update"),
  connectionId: z.string(),
  externalId: z.number(),
});
const requestSchema = z.discriminatedUnion("type", [
  createSchema,
  updateSchema,
]);

type CreateResponse = {
  host: string;
  integrationKey: string;
  connectionId: string;
};

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const body = Object.fromEntries(formData.entries());
    const parsed = requestSchema.parse(body);

    switch (parsed.type) {
      case "create": {
        const { organizationId, key } = parsed;

        const integrationInfo = integrations.find((i) => i.key === key);
        if (!integrationInfo) {
          throw new Error("Integration not found");
        }

        const connection = await createAPIConnection({
          organizationId,
          title: integrationInfo.name,
          apiIdentifier: key,
          scopes: [],
          type: APIConnectionType.HTTP,
        });

        const response: CreateResponse = {
          host: env.PIZZLY_HOST,
          integrationKey: key,
          connectionId: connection.id,
        };

        return json(response);
      }
      case "update": {
        const { connectionId, externalId } = parsed;
        return {};
      }
    }
  } catch (error: any) {
    return json({ message: error.message }, { status: 400 });
  }
};

export function Connect({
  integration,
  organizationId,
}: {
  integration: Integration;
  organizationId: string;
}) {
  const { createFetcher, status } = useCreateConnection();

  return (
    <createFetcher.Form method="post" action="/resources/connection">
      <input type="hidden" name="type" value="create" />
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="key" value={integration.key} />
      <button
        type="submit"
        disabled={status === "loading"}
        className="border border-gray-500 rounded-md flex h-12 p-1 items-center disabled:opacity-50"
      >
        <img src={integration.logo} alt={integration.name} className="h-10" />
        <h1>Connect to {integration.name}</h1>
      </button>
    </createFetcher.Form>
  );
}

type Status = "loading" | "idle";

export function useCreateConnection() {
  const createConnectionFetcher = useFetcher<CreateResponse>();
  const status: Status =
    createConnectionFetcher.state === "loading" ? "loading" : "idle";

  useEffect(() => {
    async function authenticationFlow() {
      if (createConnectionFetcher.data === undefined) return;

      try {
        const pizzly = new Pizzly(createConnectionFetcher.data.host);

        const result = await pizzly.auth(
          createConnectionFetcher.data.integrationKey,
          createConnectionFetcher.data.connectionId
        );
        console.log(
          `OAuth flow succeeded for provider "${result.providerConfigKey}" and connection-id "${result.connectionId}"!`
        );
      } catch (error: any) {
        console.error(
          `There was an error in the OAuth flow for integration "${error.providerConfigKey}" and connection-id "${error.connectionId}": ${error.error.type} - ${error.error.message}`
        );
      }
    }

    authenticationFlow();
  }, [createConnectionFetcher.data]);

  return {
    createFetcher: createConnectionFetcher,
    status,
  };
}
