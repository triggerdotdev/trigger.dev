import { useTypedRouteLoaderData } from "remix-typedjson";
import type { loader } from "../root";

export function useAppOrigin() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.appOrigin;
}

export function usePublicAppOrigin(): string | undefined {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.publicAppOrigin;
}
