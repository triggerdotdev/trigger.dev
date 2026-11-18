// Env vars that Node, libuv, OpenSSL, glibc or the dynamic loader read only when the process
// starts, so setting them once the run's env arrives over IPC has no effect.
const STARTUP_ONLY_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_ICU_DATA",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LANG",
  "LC_ALL",
  "GLIBC_TUNABLES",
]);

const STARTUP_ONLY_PREFIXES = ["UV_", "LD_", "MALLOC_"];

export function isStartupOnlyEnvName(name: string): boolean {
  return (
    STARTUP_ONLY_NAMES.has(name) || STARTUP_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The startup-only vars in `env`, to compare a run's env against later. */
export function pickStartupOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => isStartupOnlyEnvName(name)));
}

/** Names of the startup-only vars the run sets that the process did not start with. */
export function startupOnlyEnvNotApplied(
  startupEnv: Record<string, string | undefined>,
  runEnv: Record<string, string>
): string[] {
  return Object.keys(runEnv)
    .filter((name) => isStartupOnlyEnvName(name) && startupEnv[name] !== runEnv[name])
    .sort();
}

export function startupOnlyEnvWarning(names: string[]): string {
  return `These environment variables are only applied after the task process has started, so settings read at startup will not take effect: ${names.join(", ")}`;
}
