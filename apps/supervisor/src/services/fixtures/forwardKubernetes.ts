import { CoreV1Api, CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { once } from "node:events";
import { createServer, request, type RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";

// Forwards real API responses unchanged; gates delay delivery without substituting dependency behavior.
export async function forwardKubernetes(config: KubeConfig) {
  const options: RequestOptions = {};
  await config.applyToHTTPSOptions(options);
  const target = config.getCurrentCluster()!.server;
  const requests: { method: string; path: string; status?: number }[] = [];
  const releases = new Set<() => void>();
  let heldPath: ((path: string) => boolean) | undefined;
  const release = () => {
    heldPath = undefined;
    for (const resume of releases) resume();
    releases.clear();
  };
  const server = createServer({ key: options.key, cert: options.cert }, (incoming, outgoing) => {
    const entry: { method: string; path: string; status?: number } = {
      method: incoming.method ?? "GET",
      path: incoming.url ?? "/",
    };
    requests.push(entry);
    const upstream = request(
      new URL(entry.path, target),
      {
        ...options,
        method: entry.method,
        headers: incoming.headers,
      },
      (response) => {
        entry.status = response.statusCode;
        void (async () => {
          if (heldPath?.(entry.path)) {
            await new Promise<void>((resolve) => releases.add(resolve));
          }
          if (outgoing.destroyed) {
            response.destroy();
            return;
          }
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        })().catch((error) => outgoing.destroy(error));
        response.on("error", (error) => outgoing.destroy(error));
      }
    );
    upstream.on("error", (error) => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const forwarded = new KubeConfig();
  // The loopback proxy terminates TLS with the fixture client certificate; upstream TLS stays verified.
  forwarded.loadFromClusterAndUser(
    {
      ...config.getCurrentCluster()!,
      server: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      skipTLSVerify: true,
    },
    config.getCurrentUser()!
  );
  return {
    core: forwarded.makeApiClient(CoreV1Api),
    custom: forwarded.makeApiClient(CustomObjectsApi),
    requests,
    holdResponses: (predicate: (path: string) => boolean) => {
      heldPath = predicate;
      return release;
    },
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (options.agent && typeof options.agent !== "boolean") options.agent.destroy();
    },
  };
}
