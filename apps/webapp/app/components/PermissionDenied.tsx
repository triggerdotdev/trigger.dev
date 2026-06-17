import { NoSymbolIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import React from "react";
import { useOrganization } from "~/hooks/useOrganizations";
import { organizationRolesPath } from "~/utils/pathBuilder";
import { MainCenteredContainer } from "./layout/AppLayout";
import { RouteErrorDisplay } from "./ErrorDisplay";
import { LinkButton } from "./primitives/Buttons";
import { InfoPanel } from "./primitives/InfoPanel";

export function PermissionDenied({ message }: { message: React.ReactNode }) {
  const organization = useOrganization();

  return (
    <InfoPanel
      icon={NoSymbolIcon}
      iconClassName="text-text-dimmed"
      title="Permission denied"
      accessory={
        <LinkButton to={organizationRolesPath(organization)} variant="secondary/small">
          View roles
        </LinkButton>
      }
    >
      {message}
    </InfoPanel>
  );
}

const PERMISSION_DENIED_MARKER = "rbac-permission-denied";

/**
 * Throw from a loader (or action) when the current role lacks access. The
 * thrown 403 routes to the nearest `PermissionDeniedBoundary`, which renders
 * the panel — so the loader stays the single enforcement point and the page
 * component only ever renders for users who are allowed.
 */
export function throwPermissionDenied(message: string): never {
  throw json({ [PERMISSION_DENIED_MARKER]: true, message }, { status: 403 });
}

/**
 * Route `ErrorBoundary` that renders the permission panel for
 * `throwPermissionDenied`, and falls back to the default error display for
 * anything else.
 */
export function PermissionDeniedBoundary() {
  const error = useRouteError();

  if (
    isRouteErrorResponse(error) &&
    error.status === 403 &&
    error.data?.[PERMISSION_DENIED_MARKER]
  ) {
    return (
      <MainCenteredContainer>
        <PermissionDenied message={error.data.message ?? "You don't have permission to do this."} />
      </MainCenteredContainer>
    );
  }

  return <RouteErrorDisplay />;
}
