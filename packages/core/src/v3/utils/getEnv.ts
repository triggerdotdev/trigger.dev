export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  // This could run in a non-Node.js environment (Bun, Deno, CF Worker, etc.), so don't just assume process.env is a thing
  if (typeof process !== "undefined" && typeof process.env === "object" && process.env !== null) {
    return process.env[name] ?? defaultValue;
  }

  return defaultValue;
}

export function getNumberEnvVar(name: string, defaultValue?: number): number | undefined {
  const value = getEnvVar(name);

  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (isNaN(parsed)) {
    return defaultValue;
  }

  return parsed;
}
