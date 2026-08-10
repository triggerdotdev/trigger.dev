import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { describe, expect, it } from "vitest";
import { generateContainerfile } from "./buildImage.js";

const nodeImages: Array<[BuildRuntime, string]> = [
  [
    "node-24",
    "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
  ],
  [
    "node-26",
    "node:26.4.0-bookworm-slim@sha256:ec82d089a8ae2cf02628da7b34ea57dc357b24db724d557fe2d240e6beb659c1",
  ],
];

describe("generateContainerfile", () => {
  it.each(nodeImages)("selects the pinned multiplatform image for %s", async (runtime, image) => {
    const containerfile = await generateContainerfile({
      runtime,
      build: {},
      image: undefined,
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile).toContain(`FROM ${image} AS base`);
  });

  it.each(["node", "bun"] as BuildRuntime[])(
    "splits node_modules and app code into separate layers for %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      const user = runtime === "bun" ? "bun:bun" : "node:node";

      expect(containerfile).toContain("FROM build AS code");
      expect(containerfile).toContain("RUN rm -rf node_modules");
      expect(containerfile).toContain(
        `COPY --from=build --chown=${user} /app/node_modules ./node_modules`
      );
      expect(containerfile).toContain(`COPY --from=code --chown=${user} /app ./`);
      // The final stage must not copy all of /app from the build stage anymore,
      // or node_modules would be duplicated across two layers
      expect(containerfile).not.toContain(`COPY --from=build --chown=${user} /app ./`);

      // node_modules must exist even for projects with zero external dependencies
      expect(containerfile).toContain("mkdir -p node_modules");
    }
  );
});
