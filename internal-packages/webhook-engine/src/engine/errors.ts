/**
 * A failure of our own infrastructure (database, Redis, the network to S2 or the run engine) rather
 * than of the delivery. A webhook job retries these with capped backoff for as long as they last: an
 * acknowledged delivery is never given up on because a dependency was down.
 */
export class WebhookInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookInfrastructureError";
  }
}

const PRISMA_INFRASTRUCTURE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/**
 * Redis server replies that start with these codes, and ioredis's own client errors, matched against
 * the whole message so text that embeds customer input (a task id in a queue-limit error) can't match.
 * Once a failover outlasts its redirections, ioredis wraps the last of these as `Too many Cluster
 * redirections. Last error: <Name>: <message>`, so that wrapper counts too.
 */
const REDIS_UNAVAILABLE =
  /^(?:Too many Cluster redirections\. Last error: \w*Error: )?(?:(?:CLUSTERDOWN|TRYAGAIN|LOADING|READONLY|MASTERDOWN|OOM|MOVED|ASK)\b.*|Connection is closed\.|Stream isn't writeable and enableOfflineQueue options is false|Failed to refresh slots cache\.|None of startup nodes is available)$/s;

/**
 * Whether an error, or anything in its cause chain, is an infrastructure failure. Everything else,
 * unknown errors included, counts as a failure of the delivery itself, so a bug can't keep a job
 * (and its payload) retrying forever.
 */
export function isInfrastructureError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (isInfrastructureFailure(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isInfrastructureFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message, status } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  if (error instanceof WebhookInfrastructureError) return true;
  if (name === "PrismaClientInitializationError") return true;
  if (name === "PrismaClientKnownRequestError" && PRISMA_INFRASTRUCTURE_CODES.has(String(code))) {
    return true;
  }
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
  if (name === "MaxRetriesPerRequestError" || name === "ClusterAllFailedError") return true;
  if (typeof message === "string" && REDIS_UNAVAILABLE.test(message)) return true;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  return false;
}
