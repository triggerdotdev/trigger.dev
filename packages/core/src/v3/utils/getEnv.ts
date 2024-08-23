export function getEnvVar(name: string): string | undefined {
  // This could run in a non-Node.js environment (Bun, Deno, CF Worker, etc.), so don't just assume process.env is a thing
  if (typeof process !== "undefined" && typeof process.env === "object" && process.env !== null) {
    return process.env[name];
  }

  return;
}
