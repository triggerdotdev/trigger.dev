import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { describe, expect, it } from "vitest";
import {
  BASE_IMAGE,
  BUILD_IMAGE,
  DEFAULT_PACKAGES,
  TOOLCHAIN_PACKAGES,
  generateContainerfile,
} from "./buildImage.js";

const images: Array<[BuildRuntime, string, string]> = [
  [
    "node-24",
    "triggerdotdev/node:24-bookworm@sha256:d2d0c01822409f6d2de1cc69a9e718424048fa12fc64b223dfa84f6db44d0ffd",
    "triggerdotdev/node:24-bookworm-build@sha256:19322289508ae9b4be0b769acac179637e4b57d363844682f4b116feb951267d",
  ],
  [
    "node-26",
    "triggerdotdev/node:26-bookworm@sha256:0e9b19f814f32d3766a8cf167835a499349df5bd34702611577b1f75bc2d2026",
    "triggerdotdev/node:26-bookworm-build@sha256:de5cdfd683dabad582182c79779135d59faac0e6893b6cf04520d5a0dc826dd7",
  ],
  [
    "bun",
    "triggerdotdev/bun:1.3-node20-bookworm@sha256:25b467196277b9d75a37773ee36d28b65ca81a6f41786f7d7d7f1fad95fb5a31",
    "triggerdotdev/bun:1.3-node20-bookworm-build@sha256:a2d5e6d1ec25946ca1d86abdd9ffb9c589376df64ee1b490c461607953931245",
  ],
];

describe("generateContainerfile", () => {
  it.each(images)("uses the pinned published base images for %s", async (runtime, base, build) => {
    const containerfile = await generateContainerfile({
      runtime,
      build: {},
      image: undefined,
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile).toContain(`FROM ${base} AS base`);
    expect(containerfile).toContain(`FROM ${build} AS build`);
  });

  it.each(["node", "bun"] as BuildRuntime[])(
    "runs no package installation for uncustomized projects on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      expect(containerfile).not.toContain("apt-get");
      expect(containerfile).not.toContain("FROM base AS build");
    }
  );

  it("pairs every runtime image with its -build variant", () => {
    for (const runtime of Object.keys(BASE_IMAGE) as BuildRuntime[]) {
      const baseRef = BASE_IMAGE[runtime].split("@")[0];
      const buildRef = BUILD_IMAGE[runtime].split("@")[0];

      expect(buildRef).toBe(`${baseRef}-build`);
      expect(BASE_IMAGE[runtime]).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(BUILD_IMAGE[runtime]).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });

  it("matches the published base image package lists", () => {
    const imagesJson = JSON.parse(
      readFileSync(
        join(fileURLToPath(import.meta.url), "../../../../../base-images/images.json"),
        "utf-8"
      )
    );

    expect(imagesJson.packages.split(" ").sort()).toEqual([...DEFAULT_PACKAGES].sort());
    expect(imagesJson.buildPackages).toBe(TOOLCHAIN_PACKAGES);
  });

  it("applies instructions once and builds FROM base when they are present", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-22",
      build: {},
      image: {
        pkgs: ["jq", "curl", "git"],
        instructions: ["RUN echo custom > /etc/marker"],
      },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    // sorted, defaults filtered out, downgrades allowed for pinned defaults,
    // and repaired first: apt-get install refuses to run on dpkg state broken
    // by an instruction
    const installRun = `apt-get --fix-broken install -y --no-install-recommends && \\
  apt-get install -y --no-install-recommends --allow-downgrades curl jq`;
    const first = containerfile.indexOf(installRun);

    expect(first).toBeGreaterThan(containerfile.indexOf("RUN echo custom > /etc/marker"));
    expect(containerfile.indexOf(installRun, first + 1)).toBe(-1);
    expect(containerfile).toContain("FROM base AS build");
    expect(containerfile).toContain(TOOLCHAIN_PACKAGES);
  });

  it("keeps the prebuilt toolchain image for package-only projects", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-22",
      build: {},
      image: { pkgs: ["jq"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const installLine = "apt-get install -y --no-install-recommends --allow-downgrades jq";
    const first = containerfile.indexOf(installLine);

    // installed in both stages, since base and build are separate images
    expect(first).toBeGreaterThan(-1);
    expect(containerfile.indexOf(installLine, first + 1)).toBeGreaterThan(first);
    expect(containerfile).not.toContain("FROM base AS build");
    // a pristine base has nothing to repair
    expect(containerfile).not.toContain("--fix-broken");
  });

  it("repairs dpkg state after instructions when there are no user packages", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-22",
      build: {},
      image: { instructions: ["RUN echo custom > /etc/marker"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const instructions = containerfile.indexOf("RUN echo custom > /etc/marker");
    const repair = containerfile.indexOf("apt-get --fix-broken install -y");

    expect(instructions).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(instructions);
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
      expect(containerfile).toContain(
        `COPY --from=build --chown=${user} /app/node_modules ./node_modules`
      );
      expect(containerfile).toContain(`COPY --from=code --chown=${user} /app ./`);
      // copying all of /app from build would duplicate node_modules across two layers
      expect(containerfile).not.toContain(`COPY --from=build --chown=${user} /app ./`);
    }
  );

  it.each(["node", "bun"] as BuildRuntime[])(
    "orders post-install commands, the node_modules guard, and the code stage for %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: { commands: ["echo post-install"] },
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      const postInstall = containerfile.indexOf("RUN echo post-install");
      // guard after post-install so a command that prunes node_modules can't break the COPY
      const mkdirGuard = containerfile.indexOf("RUN mkdir -p node_modules");
      const codeStage = containerfile.indexOf("FROM build AS code");
      const rmNodeModules = containerfile.indexOf(
        "RUN chmod -R u+rwX node_modules && rm -rf node_modules"
      );

      expect(postInstall).toBeGreaterThan(-1);
      expect(mkdirGuard).toBeGreaterThan(postInstall);
      expect(codeStage).toBeGreaterThan(mkdirGuard);
      expect(rmNodeModules).toBeGreaterThan(codeStage);
    }
  );
});
