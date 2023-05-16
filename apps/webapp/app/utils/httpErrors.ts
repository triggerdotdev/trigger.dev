export function friendlyErrorDisplay(statusCode: number, statusText?: string) {
  switch (statusCode) {
    case 404:
      return {
        title: "404: Page not found",
        message: "The page you're looking for doesn't exist.",
      };
    case 500:
      return {
        title: "500: Server error",
        message: "Something went wrong on our end. Please try again later.",
      };
    default:
      return {
        title: `${statusCode}: Error`,
        message: statusText ?? "An error occurred.",
      };
  }
}
