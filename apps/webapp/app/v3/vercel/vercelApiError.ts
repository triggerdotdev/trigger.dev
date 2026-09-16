import { vercelErrorLogMetadata } from "./vercelErrorLogMetadata";

export const VERCEL_API_ERROR_MESSAGE = "Vercel API request failed";

export type VercelApiError = {
  message: string;
  authInvalid: boolean;
};

function isVercelApiError(error: unknown): error is VercelApiError {
  return (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    "authInvalid" in error &&
    typeof (error as VercelApiError).message === "string" &&
    typeof (error as VercelApiError).authInvalid === "boolean"
  );
}

export function toVercelApiError(error: unknown): VercelApiError {
  const status = vercelErrorLogMetadata(error).status;
  const authInvalid = isVercelApiError(error)
    ? error.authInvalid
    : status === 401 ||
      status === 403 ||
      (typeof error === "string" && (error.includes("401") || error.includes("403")));

  return {
    message: VERCEL_API_ERROR_MESSAGE,
    authInvalid,
  };
}
