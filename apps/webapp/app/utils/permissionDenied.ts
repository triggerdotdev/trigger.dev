import { json } from "@remix-run/server-runtime";

// Marker on the thrown 403 body so the error boundary can tell a
// permission denial apart from any other route error.
export const PERMISSION_DENIED_MARKER = "rbac-permission-denied";

const DEFAULT_PERMISSION_DENIED_MESSAGE = "You don't have permission to access this page.";

/** Build the 403 response thrown when the current role lacks access. */
export function permissionDeniedResponse(message?: string): Response {
  return json(
    { [PERMISSION_DENIED_MARKER]: true, message: message ?? DEFAULT_PERMISSION_DENIED_MESSAGE },
    { status: 403 }
  );
}

/**
 * Throw from a loader/action when the current role lacks access. The thrown
 * 403 bubbles to the nearest route ErrorBoundary, where RouteErrorDisplay
 * renders the permission panel. `dashboardLoader`/`dashboardAction` do this
 * automatically when an `authorization` block fails; call this directly for
 * checks the block can't express (e.g. "any of these permissions").
 */
export function throwPermissionDenied(message?: string): never {
  throw permissionDeniedResponse(message);
}

/** Returns the message when `data` is a permission-denied payload, else null. */
export function permissionDeniedMessage(data: unknown): string | null {
  if (
    data &&
    typeof data === "object" &&
    (data as Record<string, unknown>)[PERMISSION_DENIED_MARKER]
  ) {
    const message = (data as Record<string, unknown>).message;
    return typeof message === "string" ? message : DEFAULT_PERMISSION_DENIED_MESSAGE;
  }
  return null;
}
