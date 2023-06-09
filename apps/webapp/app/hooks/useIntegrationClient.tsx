import type { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader as clientLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam/route";
import { hydrateObject, useMatchesData } from "~/utils";

export type MatchedClient = UseDataFunctionReturn<
  typeof clientLoader
>["client"];

export function useOptionalIntegrationClient() {
  const routeMatch = useMatchesData(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam"
  );

  if (!routeMatch || !routeMatch.data.client) {
    return undefined;
  }

  const result = hydrateObject<
    UseDataFunctionReturn<typeof clientLoader>["client"]
  >(routeMatch.data.client);

  if (result == null) return undefined;
  return result;
}

export function useIntegrationClient() {
  const client = useOptionalIntegrationClient();
  invariant(client, "Client must be defined");
  return client;
}
