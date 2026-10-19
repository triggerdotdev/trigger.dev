export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;
const SECRET_ERROR_CODES = new Set(["missing-input-secret", "invalid-input-secret"]);
const TOKEN_ERROR_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
]);

export type TurnstileVerification =
  | { outcome: "passed" }
  | { outcome: "failed"; errorCodes: string[]; misconfigured: boolean }
  | { outcome: "unavailable"; reason: string };

/**
 * Verifies a Cloudflare Turnstile token with the siteverify API.
 *
 * Only an explicit `success` boolean is a verdict. `passed` needs `success: true`
 * on a 2xx with no token error code. `failed` means Cloudflare said no: a token
 * error code (missing, invalid, expired or already used, which always wins) or
 * `success: false`, including a wrong secret (`misconfigured`). Callers refuse
 * the request.
 *
 * `unavailable` means Cloudflare gave no verdict: a network error, the timeout
 * (which also bounds reading the body), a body that isn't JSON or has no
 * `success` boolean, a 5xx, or Cloudflare's own `internal-error`. Callers let
 * the request through and log it, so a siteverify outage doesn't lock everyone
 * out of email sign-in.
 */
export async function verifyTurnstileToken({
  secretKey,
  token,
  remoteIp,
  siteverifyUrl = TURNSTILE_SITEVERIFY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  secretKey: string;
  token: string | undefined;
  remoteIp?: string | null;
  siteverifyUrl?: string;
  timeoutMs?: number;
}): Promise<TurnstileVerification> {
  if (!token) {
    return { outcome: "failed", errorCodes: ["missing-input-response"], misconfigured: false };
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(siteverifyUrl, { method: "POST", body, signal });
  } catch (error) {
    return { outcome: "unavailable", reason: errorMessage(error) };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: `siteverify returned ${response.status} without a readable JSON body: ${errorMessage(error)}`,
    };
  }

  const result: { success?: unknown; "error-codes"?: unknown } =
    typeof parsed === "object" && parsed !== null ? parsed : {};
  const errorCodes = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string")
    : [];

  if (errorCodes.some((code) => TOKEN_ERROR_CODES.has(code))) {
    return { outcome: "failed", errorCodes, misconfigured: false };
  }

  if (typeof result.success !== "boolean") {
    return {
      outcome: "unavailable",
      reason: `siteverify returned ${response.status} without a verdict`,
    };
  }

  if (response.ok && result.success) {
    return { outcome: "passed" };
  }

  if (response.status >= 500 || errorCodes.includes("internal-error")) {
    return {
      outcome: "unavailable",
      reason: `siteverify returned ${response.status}${
        errorCodes.length ? ` (${errorCodes.join(", ")})` : ""
      }`,
    };
  }

  return {
    outcome: "failed",
    errorCodes,
    misconfigured: errorCodes.some((code) => SECRET_ERROR_CODES.has(code)),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
