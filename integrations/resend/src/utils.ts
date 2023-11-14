import { ErrorResponse } from "resend";

interface ResendErrorResponse extends ErrorResponse {
  statusCode: number;
}

function isRequestError(error: unknown): error is ResendErrorResponse {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    "name" in error &&
    typeof error.name === "string" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

// See https://resend.com/docs/api-reference/errors
const retriableErrorCode = ["rate_limit_exceeded", "application_error", "internal_server_error"];

export function handleResendError(error: unknown) {
  if (isRequestError(error)) {
    if (retriableErrorCode.includes(error.name)) {
      return error;
    }

    return {
      skipRetrying: true,
      error,
    };
  }

  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new Error(error.message);
  }

  return new Error("Unknown error");
}
