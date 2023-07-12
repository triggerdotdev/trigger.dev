import { useTypedRouteLoaderData } from "remix-typedjson";
import { RunCompletedDetail } from "~/components/run/RunCompletedDetail";
import type { loader as runLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.triggers_.external.$triggerParam_.runs.$runParam/route";

function useTriggerRegisterRun() {
  const routeMatch = useTypedRouteLoaderData<typeof runLoader>(
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.triggers_.external.$triggerParam_.runs.$runParam"
  );

  if (!routeMatch || !routeMatch.run) {
    throw new Error("No run found");
  }

  return routeMatch.run;
}

export default function RunCompletedPage() {
  const run = useTriggerRegisterRun();
  return <RunCompletedDetail run={run} />;
}
