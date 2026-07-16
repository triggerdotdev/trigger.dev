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
});
