const SAFE_VERCEL_ERROR_NAMES = new Set([
  "BadRequest",
  "ConnectionError",
  "Error",
  "Forbidden",
  "HTTPClientError",
  "HttpApiDecodeError",
  "InternalServerError",
  "InvalidRequestError",
  "NotAuthorizedForScope",
  "NotFound",
  "RequestAbortedError",
  "RequestTimeoutError",
  "ResponseValidationError",
  "SDKError",
  "SDKValidationError",
  "TooManyRequests",
  "Unauthorized",
  "UnexpectedClientError",
  "VercelError",
]);

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";

  const candidates = [error.constructor.name, error.name];
  return (
    candidates.find((name) => name !== "Error" && SAFE_VERCEL_ERROR_NAMES.has(name)) ?? "Error"
  );
}

function validHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function vercelErrorLogMetadata(error: unknown): {
  errorType: string;
  status?: number;
} {
  if (!error || typeof error !== "object") {
    return { errorType: "UnknownError" };
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  const status =
    validHttpStatus(candidate.statusCode) ??
    validHttpStatus(candidate.status) ??
    validHttpStatus(candidate.response?.status);

  return status === undefined
    ? { errorType: safeErrorName(error) }
    : { errorType: safeErrorName(error), status };
}
