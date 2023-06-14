import {
  UseDataFunctionReturn,
  useTypedRouteLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam/route";

export type MatchedClient = UseDataFunctionReturn<typeof loader>["client"];

export function useOptionalIntegrationClient() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam"
  );

  return routeMatch?.client;
}

export function useIntegrationClient() {
  const client = useOptionalIntegrationClient();
  invariant(client, "Client must be defined");
  return client;
}
