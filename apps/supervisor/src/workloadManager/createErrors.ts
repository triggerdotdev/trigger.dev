/** A create that failed and left no workload running, so its run can be given back. */
export class WorkloadNotCreatedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkloadNotCreatedError";
  }
}

/**
 * Whether the Kubernetes API refused a create, so nothing exists: a 4xx other than a 408, which a
 * proxy may answer after forwarding the request, a 409 for a name in use, or a 429 asking every
 * create to slow down.
 */
export function k8sCreateRefused(error: unknown): boolean {
  const { code } = (error ?? {}) as { code?: unknown };
  return (
    typeof code === "number" &&
    code >= 400 &&
    code < 500 &&
    code !== 408 &&
    code !== 409 &&
    code !== 429
  );
}

/** The message of a Kubernetes API error, whose body is the response's raw text. */
export function k8sErrorMessage(error: unknown): string {
  const { body, message } = (error ?? {}) as { body?: unknown; message?: unknown };
  if (typeof body === "string") {
    try {
      const status = JSON.parse(body) as { message?: unknown };
      if (typeof status.message === "string") return status.message;
    } catch {}
  }
  return typeof message === "string" ? message : "Create failed";
}

// 304 already started, 409 a name in use, 502 to 504 a proxy's answer in place of the daemon's.
const DOCKER_NOT_REFUSED = new Set([304, 409, 502, 503, 504]);

/**
 * Whether the Docker daemon refused an image pull, a container create or a start, so nothing is
 * running. Only the daemon's own answer says so, and not one that reports a timeout.
 */
export function dockerCreateRefused(error: unknown): boolean {
  const { statusCode, message } = (error ?? {}) as { statusCode?: unknown; message?: unknown };
  return (
    typeof statusCode === "number" &&
    !DOCKER_NOT_REFUSED.has(statusCode) &&
    !/time-?d? ?out|deadline exceeded/i.test(String(message))
  );
}

/** Whether removing a container failed only because it is gone or already being removed. */
export function dockerContainerGone(error: unknown): boolean {
  const { statusCode } = (error ?? {}) as { statusCode?: unknown };
  return statusCode === 404 || statusCode === 409;
}
