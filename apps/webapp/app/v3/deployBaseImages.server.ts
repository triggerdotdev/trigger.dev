import { BuildRuntime } from "@trigger.dev/core/v3";

type BaseImageMap = Partial<Record<BuildRuntime, string>>;

const DIGEST_PINNED = /@sha256:[a-f0-9]{64}$/;

function invalidSegment(envVarName: string, segment: string, reason: string): Error {
  return new Error(`${envVarName}: ${reason} in "${segment}"`);
}

export function parseDeployBaseImages(value: string | undefined, envVarName: string): BaseImageMap {
  const result: BaseImageMap = {};

  if (!value) {
    return result;
  }

  for (const segment of value.split(",").map((s) => s.trim())) {
    if (!segment) {
      continue;
    }

    const separator = segment.indexOf("=");
    if (separator === -1) {
      throw invalidSegment(envVarName, segment, "expected runtime=image");
    }

    const runtimeName = segment.slice(0, separator).trim();
    const image = segment.slice(separator + 1).trim();

    const runtime = BuildRuntime.safeParse(runtimeName);
    if (!runtime.success) {
      throw invalidSegment(
        envVarName,
        segment,
        `unknown runtime "${runtimeName}" (expected one of ${BuildRuntime.options.join(", ")})`
      );
    }

    if (!image) {
      throw invalidSegment(envVarName, segment, "missing image");
    }

    if (!DIGEST_PINNED.test(image)) {
      throw invalidSegment(envVarName, segment, "image must be pinned by digest (@sha256:<64 hex chars>)");
    }

    if (runtime.data in result) {
      throw invalidSegment(envVarName, segment, `duplicate runtime "${runtimeName}"`);
    }

    result[runtime.data] = image;
  }

  return result;
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
