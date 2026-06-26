import { useTypedRouteLoaderData } from "remix-typedjson";
import { loader } from "../root";

export function useApiOrigin() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.apiOrigin;
}
