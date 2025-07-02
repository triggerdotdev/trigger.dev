import { useTypedRouteLoaderData } from "remix-typedjson";
import { type loader } from "~/root";

export function useTriggerCliTag() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.triggerCliTag;
}
