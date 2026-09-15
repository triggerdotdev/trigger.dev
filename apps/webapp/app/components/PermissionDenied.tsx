import { NoSymbolIcon } from "@heroicons/react/20/solid";
import React from "react";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { organizationRolesPath } from "~/utils/pathBuilder";
import { LinkButton } from "./primitives/Buttons";
import { InfoPanel } from "./primitives/InfoPanel";

export function PermissionDenied({ message }: { message: React.ReactNode }) {
  const organization = useOptionalOrganization();

  return (
    <InfoPanel
      icon={NoSymbolIcon}
      iconClassName="text-text-dimmed"
      title="Permission denied"
      accessory={
        organization ? (
          <LinkButton to={organizationRolesPath(organization)} variant="secondary/small">
            View roles
          </LinkButton>
        ) : undefined
      }
    >
      {message}
    </InfoPanel>
  );
}
