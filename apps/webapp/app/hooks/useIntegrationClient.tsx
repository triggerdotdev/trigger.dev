import { type UIMatch } from "@remix-run/react";
import { type UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.integrations_.$clientParam/route";
import { useTypedMatchesData } from "./useTypedMatchData";

export type MatchedClient = UseDataFunctionReturn<typeof loader>["client"];

export function useOptionalIntegrationClient(matches?: UIMatch[]) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug.integrations_.$clientParam",
    matches,
  });

  return routeMatch?.client;
}

export function useIntegrationClient(matches?: UIMatch[]) {
  const integration = useOptionalIntegrationClient(matches);
  invariant(integration, "Integration must be defined");
  return integration;
}
