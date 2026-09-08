const UNSUPPORTED_ZOD_MESSAGE = `Your installed Zod version is not supported by Trigger.dev.

Trigger.dev requires zod@^3.25.56 or zod@^4.0.0. Upgrade Zod, reinstall your dependencies, and try again.

See https://trigger.dev/docs/troubleshooting-zod for upgrade guidance.`;

export function formatCommandError(error: unknown): string {
  if (isUnsupportedZodError(error)) {
    return UNSUPPORTED_ZOD_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedZodError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      const code = "code" in current ? current.code : undefined;
      const message = current.message;

      if (
        code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
        /Package subpath ['"]\.\/v4(?:\/core)?['"] is not defined by ["']exports["']/.test(
          message
        ) &&
        /[\\/]node_modules[\\/]zod[\\/]package\.json/.test(message)
      ) {
        return true;
      }

      if (
        code === "ERR_MODULE_NOT_FOUND" &&
        /[\\/]node_modules[\\/]zod[\\/]dist[\\/](?:esm|commonjs)[\\/]/.test(message)
      ) {
        return true;
      }

      current = current.cause;
      continue;
    }

    break;
  }

  return false;
}
