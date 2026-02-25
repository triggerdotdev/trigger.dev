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
