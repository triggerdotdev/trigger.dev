import { BuildRuntime, DeployBaseImageRef } from "@trigger.dev/core/v3";

type BaseImageMap = Partial<Record<BuildRuntime, string>>;

export type ParsedDeployBaseImages = { images: BaseImageMap; errors: string[] };

export function parseDeployBaseImages(
  value: string | undefined,
  envVarName: string
): ParsedDeployBaseImages {
  const images: BaseImageMap = {};
  const errors: string[] = [];

  if (!value) {
    return { images, errors };
  }

  for (const segment of value.split(",").map((s) => s.trim())) {
    if (!segment) {
      continue;
    }

    const fail = (reason: string) => errors.push(`${envVarName}: ${reason} in "${segment}"`);

    const separator = segment.indexOf("=");
    if (separator === -1) {
      fail("expected runtime=image");
      continue;
    }

    const runtimeName = segment.slice(0, separator).trim();
    const image = segment.slice(separator + 1).trim();

    if (runtimeName === "node") {
      fail('runtime "node" is an alias; use the concrete runtime (node-22, node-24, node-26)');
      continue;
    }

    const runtime = BuildRuntime.safeParse(runtimeName);
    if (!runtime.success) {
      fail(`unknown runtime "${runtimeName}" (expected one of ${BuildRuntime.options.join(", ")})`);
      continue;
    }

    if (!image) {
      fail("missing image");
      continue;
    }

    if (!DeployBaseImageRef.safeParse(image).success) {
      fail("image must be image@sha256:<64 hex chars> with no whitespace before the digest");
      continue;
    }

    if (runtime.data in images) {
      fail(`duplicate runtime "${runtimeName}"`);
      continue;
    }

    images[runtime.data] = image;
  }

  return { images, errors };
}

export function resolveDeployBaseImages(
  runtime: string | null | undefined,
  config: { base: BaseImageMap; buildBase: BaseImageMap }
): { base?: string; buildBase?: string } | undefined {
  const parsedRuntime = BuildRuntime.safeParse(runtime);
  if (!parsedRuntime.success) {
    return undefined;
  }

  const base = config.base[parsedRuntime.data];
  const buildBase = config.buildBase[parsedRuntime.data];

  if (!base && !buildBase) {
    return undefined;
  }

  return {
    ...(base ? { base } : {}),
    ...(buildBase ? { buildBase } : {}),
  };
}
