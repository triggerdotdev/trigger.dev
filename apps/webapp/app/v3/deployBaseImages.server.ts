type BaseImages = { base?: string; buildBase?: string };

/** Base images the operator requires for a runtime, from `runtime=image` csv env vars. */
export function resolveDeployBaseImages(
  runtime: string | null | undefined,
  config: { base?: string; buildBase?: string }
): BaseImages | undefined {
  if (!runtime) {
    return undefined;
  }

  const base = parseImageMap(config.base)[runtime];
  const buildBase = parseImageMap(config.buildBase)[runtime];

  if (!base && !buildBase) {
    return undefined;
  }

  return {
    ...(base ? { base } : {}),
    ...(buildBase ? { buildBase } : {}),
  };
}

function parseImageMap(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          return [];
        }
        const runtime = entry.slice(0, separator).trim();
        const image = entry.slice(separator + 1).trim();
        return image ? [[runtime, image] as const] : [];
      })
  );
}
