export function throwNotFound(statusText: string): never {
  throw new Response(undefined, { status: 404, statusText });
}

export function friendlyErrorDisplay(statusCode: number, statusText?: string) {
  switch (statusCode) {
    case 400:
      return {
        title: "400: Bad request",
        message: statusText ?? "The request was invalid.",
      };
    case 401:
      return {
        title: "401: Unauthorized",
        message: statusText ?? "Please sign in to continue.",
      };
    case 403:
      return {
        title: "403: Forbidden",
        message: statusText ?? "You don't have permission to access this resource.",
      };
    case 404:
      return {
        title: "404: Page not found",
        message: statusText ?? "The page you're looking for doesn't exist.",
      };
    case 429:
      return {
        title: "429: Too many requests",
        message: statusText ?? "Please wait a moment and try again.",
      };
    case 500:
      return {
        title: "500: Server error",
        message: statusText ?? "Something went wrong on our end. Please try again later.",
      };
    default:
      return {
        title: `${statusCode}: Error`,
        message: statusText ?? "An error occurred.",
      };
  }
}

/**
 * Safely extract a user-facing message from a Remix route error response.
 * `error.data` can be null, a string, or an object — never assume `.message`.
 */
export function getRouteErrorMessage(status: number, statusText: string, data: unknown): string {
  const fallback = friendlyErrorDisplay(status, statusText).message;

  if (typeof data === "string" && data.length > 0) {
    return data;
  }

  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return fallback;
}
