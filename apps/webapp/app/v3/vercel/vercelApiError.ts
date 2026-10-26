import { z } from "zod";
import { vercelErrorLogMetadata } from "./vercelErrorLogMetadata";

export const VERCEL_API_ERROR_MESSAGE = "Vercel API request failed";

const DISABLED_ERROR_CODE = "integration_configuration_disabled";

const VercelErrorBody = z.object({ error: z.object({ code: z.string() }) });

type VercelApiErrorReason = "revoked" | "disabled" | "other";

export type VercelApiError = {
  message: string;
  reason: VercelApiErrorReason;
  authInvalid: boolean;
};

function isVercelApiError(error: unknown): error is VercelApiError {
  return (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    "reason" in error &&
    "authInvalid" in error &&
    typeof (error as VercelApiError).message === "string" &&
    ["revoked", "disabled", "other"].includes((error as VercelApiError).reason) &&
    typeof (error as VercelApiError).authInvalid === "boolean"
  );
}

function vercelErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("body" in error)) return undefined;
  if (typeof error.body !== "string") return undefined;

  try {
    const parsed = VercelErrorBody.safeParse(JSON.parse(error.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

function vercelErrorReason(error: unknown): VercelApiErrorReason {
  const status = vercelErrorLogMetadata(error).status;
  if ((status === 401 || status === 403) && vercelErrorCode(error) === DISABLED_ERROR_CODE) {
    return "disabled";
  }

  const authFailure =
    status === 401 ||
    status === 403 ||
    (typeof error === "string" && (error.includes("401") || error.includes("403")));

  return authFailure ? "revoked" : "other";
}

export function toVercelApiError(error: unknown): VercelApiError {
  const reason = isVercelApiError(error) ? error.reason : vercelErrorReason(error);

  return {
    message: VERCEL_API_ERROR_MESSAGE,
    reason,
    authInvalid: reason === "revoked",
  };
}
