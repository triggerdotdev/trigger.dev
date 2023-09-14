import { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { proxyToRegistry } from "~/services/docker/registryProxy.server";

export async function action({ request }: ActionArgs) {
  return await proxyToRegistry(request);
}

export async function loader({ request, params }: LoaderArgs) {
  return await proxyToRegistry(request);
}
