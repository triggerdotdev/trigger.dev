import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { describe, expect, it } from "vitest";
import {
  BASE_IMAGE,
  BUILD_IMAGE,
  DEFAULT_PACKAGES,
  EMSIGN_COMPROMISE_DISTRUSTED_ROOTS,
  EMSIGN_REJECT_DIR,
  TOOLCHAIN_PACKAGES,
  formatCommandForDiagnostics,
  generateContainerfile,
} from "./buildImage.js";
import { EMSIGN_COMPROMISE_REJECTED_INTERMEDIATES } from "./emsignRejectedIntermediates.js";

describe("formatCommandForDiagnostics", () => {
  it("redacts build argument values without changing the executable arguments", () => {
    const args = ["build", "--build-arg", "PUBLIC=value", "--build-arg", "SECRET=very-secret", "."];

    expect(formatCommandForDiagnostics(args)).toBe(
      "build --build-arg PUBLIC=[REDACTED] --build-arg SECRET=[REDACTED] ."
    );
    expect(args).toEqual([
      "build",
      "--build-arg",
      "PUBLIC=value",
      "--build-arg",
      "SECRET=very-secret",
      ".",
    ]);
  });
});

const images: Array<[BuildRuntime, string, string]> = [
  [
    "node",
    "triggerdotdev/node:24-bookworm@sha256:3cdc82425d824f1059fddd64b881947bf8edf4f0a5a9176145dba4889f8731ff",
    "triggerdotdev/node:24-bookworm-build@sha256:34a3f4554d1684e078b104bd2b7ba6743776ad9002ebceef707dee91fa629c41",
  ],
  [
    "node-24",
    "triggerdotdev/node:24-bookworm@sha256:3cdc82425d824f1059fddd64b881947bf8edf4f0a5a9176145dba4889f8731ff",
    "triggerdotdev/node:24-bookworm-build@sha256:34a3f4554d1684e078b104bd2b7ba6743776ad9002ebceef707dee91fa629c41",
  ],
  [
    "node-26",
    "triggerdotdev/node:26-bookworm@sha256:e319f1134f8d4228be3adda596d1b97568f8eb09a3fbdac736594d0cbbd7e5cb",
    "triggerdotdev/node:26-bookworm-build@sha256:86d5a599fc69a81e15c1276440702144cd3d857258fdaf78f8c9b864768c1ab9",
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
    "runs the indexer in exec form so entry paths with spaces survive on %s",
    async (runtime) => {
      const indexScript = "/app/Documents/Trigger Demo/index.mjs";
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript,
        entrypoint: "entrypoint.js",
      });

      expect(containerfile).toContain(`"${indexScript}" ]`);
      expect(containerfile).not.toMatch(/^RUN (node|bun run) \//m);
    }
  );

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

  const distrustSteps = (containerfile: string) =>
    containerfile.match(
      /^RUN sed .* \/etc\/ca-certificates\.conf && \\\n {2}update-ca-certificates --fresh$/gm
    ) ?? [];

  it.each(["node", "bun"] as BuildRuntime[])(
    "distrusts the compromised emSign roots in the base and prebuilt build stages on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      const steps = distrustSteps(containerfile);
      expect(steps).toHaveLength(2);
      for (const root of EMSIGN_COMPROMISE_DISTRUSTED_ROOTS) {
        expect(steps[0]).toContain(`${root}`);
      }
      expect(steps[0]).not.toContain("emSign_Root_CA_-_G1");
      expect(containerfile.match(/^ENV NODE_OPTIONS=--use-openssl-ca$/gm)).toHaveLength(2);
    }
  );

  it("keeps --use-openssl-ca when the indexer overrides NODE_OPTIONS", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node",
      build: {},
      image: undefined,
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const indexerOptions = containerfile.match(/NODE_OPTIONS="[^"]*"/g) ?? [];
    expect(indexerOptions).toHaveLength(1);
    expect(indexerOptions[0]).toContain("--use-openssl-ca");
  });

  it("distrusts the roots once when the build stage derives from base", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node",
      build: {},
      image: { instructions: ["RUN echo hi"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(distrustSteps(containerfile)).toHaveLength(1);
    expect(containerfile.indexOf("RUN echo hi")).toBeLessThan(
      containerfile.indexOf("update-ca-certificates")
    );
  });

  const osTrustStoreEnv =
    /^ENV SSL_CERT_FILE=\$\{SSL_CERT_FILE:-\/etc\/ssl\/certs\/ca-certificates\.crt\} REQUESTS_CA_BUNDLE=\$\{REQUESTS_CA_BUNDLE:-\/etc\/ssl\/certs\/ca-certificates\.crt\} PIP_CERT=\$\{PIP_CERT:-\/etc\/ssl\/certs\/ca-certificates\.crt\}$/gm;

  it("keeps a trust bundle set by image instructions", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node",
      build: {},
      image: { instructions: ["ENV REQUESTS_CA_BUNDLE=/app/certs/corp.pem"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const instruction = containerfile.indexOf("ENV REQUESTS_CA_BUNDLE=/app/certs/corp.pem");
    expect(instruction).toBeGreaterThan(-1);
    expect(instruction).toBeLessThan(containerfile.search(osTrustStoreEnv));
  });

  it.each(["node", "bun"] as BuildRuntime[])(
    "points certifi users at the OS trust store in the base and prebuilt build stages on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      expect(containerfile.match(osTrustStoreEnv)).toHaveLength(2);
    }
  );

  it("points certifi users at the OS trust store once when the build stage derives from base", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node",
      build: {},
      image: { instructions: ["RUN echo hi"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile.match(osTrustStoreEnv)).toHaveLength(1);
  });

  const rejectSteps = (containerfile: string) =>
    Array.from(
      containerfile.matchAll(
        /^RUN mkdir -p \/usr\/local\/share\/ca-certificates\/emsign-block && \\$/gm
      )
    );

  const pemFromStep = (containerfile: string, file: string) => {
    const block = containerfile.match(
      new RegExp(
        `printf '%s\\\\n' \\\\\\n((?: {4}'[^']*' \\\\\\n)+) {4}> ${EMSIGN_REJECT_DIR}/${file}`
      )
    );
    return block ? block[1]!.match(/'([^']*)'/g)!.map((q) => q.slice(1, -1)) : [];
  };

  it.each(["node", "bun"] as BuildRuntime[])(
    "writes the emSign reject entries before refreshing the store in the base and prebuilt build stages on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: undefined,
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      const rejects = rejectSteps(containerfile);
      const refreshes = Array.from(
        containerfile.matchAll(/^ {2}update-ca-certificates --fresh$/gm)
      );
      expect(rejects).toHaveLength(2);
      expect(refreshes).toHaveLength(2);
      expect(rejects[0]!.index).toBeLessThan(refreshes[0]!.index!);
      expect(rejects[1]!.index).toBeGreaterThan(refreshes[0]!.index!);
      expect(rejects[1]!.index).toBeLessThan(refreshes[1]!.index!);

      for (const { file, pemLines } of EMSIGN_COMPROMISE_REJECTED_INTERMEDIATES) {
        expect(pemFromStep(containerfile, file)).toEqual(pemLines);
      }
    }
  );

  it("writes the reject entries once when the build stage derives from base", async () => {
    const containerfile = await generateContainerfile({
      runtime: "bun",
      build: {},
      image: { instructions: ["RUN echo hi"] },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(rejectSteps(containerfile)).toHaveLength(1);
  });

  it("ships reject entries that are safe to embed in a shell command", () => {
    expect(EMSIGN_COMPROMISE_REJECTED_INTERMEDIATES).toHaveLength(8);
    for (const { file, pemLines } of EMSIGN_COMPROMISE_REJECTED_INTERMEDIATES) {
      expect(file).toMatch(/^emsign-block-EM-(DV|OV|EV)-(TLS|CS)-CA-G3[BC]-by-[A-Za-z0-9-]+\.crt$/);
      expect(pemLines[0]).toBe("-----BEGIN TRUSTED CERTIFICATE-----");
      expect(pemLines.at(-1)).toBe("-----END TRUSTED CERTIFICATE-----");
      for (const line of pemLines.slice(1, -1)) {
        expect(line).toMatch(/^[A-Za-z0-9+/=]+$/);
      }
    }
  });

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

      expect(containerfile).toContain("FROM scratch AS code");
      expect(containerfile).toContain("COPY --from=build --exclude=node_modules /app /app");
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
      const codeStage = containerfile.indexOf("FROM scratch AS code");
      const excludeCopy = containerfile.indexOf(
        "COPY --from=build --exclude=node_modules /app /app"
      );

      expect(postInstall).toBeGreaterThan(-1);
      expect(mkdirGuard).toBeGreaterThan(postInstall);
      expect(codeStage).toBeGreaterThan(mkdirGuard);
      expect(excludeCopy).toBeGreaterThan(codeStage);
    }
  );

  it.each(["node", "bun"] as BuildRuntime[])(
    "uses the configured base and build images on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: {
          base: "acme/node-fips:26@sha256:abc",
          buildBase: "acme/node:26-dev@sha256:def",
        },
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      expect(containerfile).toContain("FROM acme/node-fips:26@sha256:abc AS base");
      expect(containerfile).toContain("FROM acme/node:26-dev@sha256:def AS build");
      expect(containerfile).toContain("FROM base AS final");
      expect(containerfile).not.toContain(BASE_IMAGE[runtime]);
      expect(containerfile).not.toContain(BUILD_IMAGE[runtime]);
    }
  );

  it("keeps the published build image when only the base is overridden", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: { base: "acme/node-fips:26@sha256:abc" },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile).toContain("FROM acme/node-fips:26@sha256:abc AS base");
    expect(containerfile).toContain(`FROM ${BUILD_IMAGE["node-26"]} AS build`);
  });

  it("builds on the configured build image and replays instructions there", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: {
        base: "acme/node-fips:26@sha256:abc",
        buildBase: "acme/node:26-dev@sha256:def",
        pkgs: ["jq"],
        instructions: ["RUN echo first > /etc/first", "RUN echo second > /etc/second"],
      },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const buildStage = containerfile.slice(containerfile.indexOf("AS build"));

    expect(containerfile).toContain("FROM acme/node-fips:26@sha256:abc AS base");
    expect(containerfile).toContain("FROM acme/node:26-dev@sha256:def AS build");
    expect(containerfile).not.toContain("FROM base AS build");
    expect(containerfile).not.toContain(TOOLCHAIN_PACKAGES);
    expect(buildStage).toContain(
      "apt-get install -y --no-install-recommends --allow-downgrades jq"
    );
    expect(containerfile.indexOf("RUN echo first > /etc/first")).toBeLessThan(
      containerfile.indexOf("AS build")
    );

    const buildFrom = "FROM acme/node:26-dev@sha256:def AS build";
    const baseEnv = "ENV DEBIAN_FRONTEND=noninteractive\n\n";
    const baseStart = containerfile.indexOf(baseEnv) + baseEnv.length;
    const baseCustomization = containerfile.slice(
      baseStart,
      containerfile.indexOf(buildFrom) - "\n\n".length
    );

    expect(containerfile).toContain(`${buildFrom}\n\n${baseEnv}${baseCustomization}\n\n`);
  });

  it("builds from the base stage when instructions have no configured build image", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: {
        base: "acme/node-fips:26@sha256:abc",
        instructions: ["RUN echo custom > /etc/marker"],
      },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile).toContain("FROM acme/node-fips:26@sha256:abc AS base");
    expect(containerfile).toContain("FROM base AS build");
    expect(containerfile).toContain(TOOLCHAIN_PACKAGES);
  });

  it.each(["node", "bun"] as BuildRuntime[])(
    "leaves the trust store of configured base and build images alone on %s",
    async (runtime) => {
      const containerfile = await generateContainerfile({
        runtime,
        build: {},
        image: {
          base: "acme/node-fips:26@sha256:abc",
          buildBase: "acme/node:26-dev@sha256:def",
        },
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
      });

      expect(distrustSteps(containerfile)).toHaveLength(0);
      expect(rejectSteps(containerfile)).toHaveLength(0);
      expect(containerfile).not.toContain(EMSIGN_REJECT_DIR);
      expect(containerfile).not.toContain("--use-openssl-ca");
      expect(containerfile).not.toMatch(osTrustStoreEnv);
    }
  );

  it("hardens only the published build image when just the base is configured", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: { base: "acme/node-fips:26@sha256:abc" },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const buildStart = containerfile.indexOf(`FROM ${BUILD_IMAGE["node-26"]} AS build`);
    const steps = Array.from(containerfile.matchAll(/^ {2}update-ca-certificates --fresh$/gm));

    expect(steps).toHaveLength(1);
    expect(steps[0]!.index).toBeGreaterThan(buildStart);
    expect(containerfile).toContain('NODE_OPTIONS="--max_old_space_size=8192 --use-openssl-ca"');
  });

  it("hardens only the published base image when just the build image is configured", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: { buildBase: "acme/node:26-dev@sha256:def" },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    const buildStart = containerfile.indexOf("FROM acme/node:26-dev@sha256:def AS build");
    const steps = Array.from(containerfile.matchAll(/^ {2}update-ca-certificates --fresh$/gm));

    expect(steps).toHaveLength(1);
    expect(steps[0]!.index).toBeLessThan(buildStart);
    expect(containerfile).toContain('NODE_OPTIONS="--max_old_space_size=8192"');
  });

  it("leaves the trust store alone when the build stage derives from a configured base", async () => {
    const containerfile = await generateContainerfile({
      runtime: "node-26",
      build: {},
      image: {
        base: "acme/node-fips:26@sha256:abc",
        instructions: ["RUN echo custom > /etc/marker"],
      },
      indexScript: "index.js",
      entrypoint: "entrypoint.js",
    });

    expect(containerfile).toContain("FROM base AS build");
    expect(distrustSteps(containerfile)).toHaveLength(0);
    expect(rejectSteps(containerfile)).toHaveLength(0);
    expect(containerfile).not.toContain("--use-openssl-ca");
  });
});
