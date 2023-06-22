import { useTypedRouteLoaderData } from "remix-typedjson";
import { loader } from "../root";
import type { TriggerFeatures } from "~/features.server";

export function useFeatures(): TriggerFeatures {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch?.features ?? { isManagedCloud: false };
}
