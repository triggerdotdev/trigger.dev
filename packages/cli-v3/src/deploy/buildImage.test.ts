import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("apt snapshot pinning", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(["node", "bun"] as BuildRuntime[])(
      "pins apt to the Debian snapshot archive and scrubs timestamped files for %s",
      async (runtime) => {
        const containerfile = await generateContainerfile({
          runtime,
          build: {},
          image: undefined,
          indexScript: "index.js",
          entrypoint: "entrypoint.js",
        });

        expect(containerfile).toMatch(
          /deb \[check-valid-until=no\] http:\/\/snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z bookworm main/
        );
        expect(containerfile).toContain("/archive/debian-security/");
        expect(containerfile).toContain("rm -f /etc/apt/sources.list.d/debian.sources");
        expect(containerfile).toContain("/var/log/dpkg.log");
      }
    );

    it("keeps the default package layer identical for customized projects", async () => {
      const containerfile = await generateContainerfile({
        runtime: "node-22",
        build: {},
        image: {
          pkgs: ["jq", "curl"],
          instructions: ["RUN echo custom > /etc/marker"],
        },
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      const defaultInstall = containerfile.indexOf(
        "apt-get install -y --no-install-recommends busybox ca-certificates dumb-init git openssl"
      );
      const instructions = containerfile.indexOf("RUN echo custom > /etc/marker");
      // sorted, deduplicated, and separate from the default install line
      const userInstall = containerfile.indexOf("apt-get install -y --no-install-recommends curl jq");

      expect(defaultInstall).toBeGreaterThan(-1);
      expect(instructions).toBeGreaterThan(defaultInstall);
      expect(userInstall).toBeGreaterThan(instructions);
      // sources are only written once, in the default install
      expect(containerfile.match(/snapshot\.debian\.org/g)?.length).toBe(3);
    });

    it("drops the snapshot pin when TRIGGER_BUILD_SKIP_APT_SNAPSHOT is set", async () => {
      vi.stubEnv("TRIGGER_BUILD_SKIP_APT_SNAPSHOT", "1");

      const containerfile = await generateContainerfile({
        runtime: "node-22",
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      expect(containerfile).not.toContain("snapshot.debian.org");
      expect(containerfile).toContain("RUN apt-get update");
    }
    );
  });
});
