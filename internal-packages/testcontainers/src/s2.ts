import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { withCiResourceLimits } from "./utils";

/**
 * s2-lite 0.40.0 is the first image that emits the tail on the heartbeat ping
 * (matching cloud S2 0.25.0), which the caught-up client keys off. Older images
 * fire a bare keepalive with no tail, so the digest is pinned to keep the e2e
 * deterministic.
 */
const S2_LITE_IMAGE =
  "ghcr.io/s2-streamstore/s2:0.40.0@sha256:b26249e2ede0949755f5af8028185dc2bcfc3aa2db21eb9610543d144eb6ee9d";

const DEFAULT_BASIN = "trigger-local";

function specJson(basin: string): string {
  return JSON.stringify({
    basins: [
      {
        name: basin,
        config: { create_stream_on_append: true, create_stream_on_read: true },
      },
    ],
  });
}

export interface StartedS2Container {
  container: StartedTestContainer;
  /** Base URL of the s2-lite HTTP API, e.g. `http://localhost:49xxx`. */
  endpoint: string;
  /** The single basin s2-lite is initialised with. */
  basin: string;
}

/**
 * Boots s2-lite (the open-source S2 server) in `lite` mode with a single basin,
 * for full-stack realtime session-stream e2e. The spec is copied in rather than
 * bind-mounted so the helper carries no external file dependency.
 */
export async function createS2Container(
  network?: StartedNetwork,
  opts: { basin?: string } = {}
): Promise<StartedS2Container> {
  const basin = opts.basin ?? DEFAULT_BASIN;

  let builder = withCiResourceLimits(new GenericContainer(S2_LITE_IMAGE))
    .withExposedPorts(80)
    .withCopyContentToContainer([
      { content: specJson(basin), target: "/s2-spec.json", mode: 0o444 },
    ])
    .withCommand(["lite", "--init-file", "/s2-spec.json"])
    .withWaitStrategy(Wait.forLogMessage(/starting plain http server/))
    .withStartupTimeout(60_000);

  if (network) {
    builder = builder.withNetwork(network).withNetworkAliases("s2");
  }

  const container = await builder.start();
  const mappedPort = container.getMappedPort(80);

  return {
    container,
    endpoint: `http://${container.getHost()}:${mappedPort}`,
    basin,
  };
}
