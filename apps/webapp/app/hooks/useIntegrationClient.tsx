import { UIMatch } from "@remix-run/react";
import { UseDataFunctionReturn } from "remix-typedjson";
import invariant from "tiny-invariant";
import type { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam/route";
import { useTypedMatchesData } from "./useTypedMatchData";
import { Handle } from "~/utils/handle";
import { AppData } from "~/utils/appData";

export type MatchedClient = UseDataFunctionReturn<typeof loader>["client"];

export function useOptionalIntegrationClient(matches?: AppData[]) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug.projects.$projectParam.integrations_.$clientParam",
    matches,
  });

  return routeMatch?.client;
}

export function useIntegrationClient(matches?: UIMatch<unknown, Handle>[]) {
  const integration = useOptionalIntegrationClient(matches);
  invariant(integration, "Integration must be defined");
  return integration;
}
