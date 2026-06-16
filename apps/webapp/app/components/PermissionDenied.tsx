import { organizationRolesPath } from "~/utils/pathBuilder";
import { LinkButton } from "./primitives/Buttons";
import { InfoPanel } from "./primitives/InfoPanel";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import { useOrganization } from "~/hooks/useOrganizations";
import React from "react";

export function PermissionDenied({ message }: { message: React.ReactNode }) {
  const organization = useOrganization();

  return (
    <InfoPanel
      icon={LockClosedIcon}
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
