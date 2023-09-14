import { LoaderArgs } from "@remix-run/server-runtime";
import { proxyToRegistry } from "~/services/docker/registryProxy.server";

export async function loader({ request }: LoaderArgs) {
  return await proxyToRegistry(request);
}
