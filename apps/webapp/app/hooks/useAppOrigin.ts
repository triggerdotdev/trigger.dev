import { useTypedRouteLoaderData } from "remix-typedjson";
import { loader } from "../root";

export function useAppOrigin() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return routeMatch!.appOrigin;
}
