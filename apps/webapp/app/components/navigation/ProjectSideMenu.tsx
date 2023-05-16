import invariant from "tiny-invariant";
import { useCurrentJob } from "~/hooks/useJob";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import {
  accountPath,
  organizationBillingPath,
  organizationTeamPath,
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectPath,
} from "~/utils/pathBuilder";
import { LinkButton, NavLinkButton } from "../primitives/Buttons";
import type { IconNames } from "../primitives/NamedIcon";
import { useMatches } from "@remix-run/react";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full">{children}</div>;
}

export function ProjectSideMenu() {
  const organization = useCurrentOrganization();
  const project = useCurrentProject();
  invariant(organization, "Organization must be defined");
  invariant(project, "Project must be defined");

  const job = useCurrentJob();

  //todo also use whether there's a current integration
  const isCollapsed = job !== undefined;

  return (
    <div
      className={cn(
        "flex h-full flex-col justify-between border-r border-slate-850 p-1 transition duration-300 ease-in-out",
        isCollapsed ? "w-9" : "w-44"
      )}
    >
      <div className="flex flex-col gap-1">
        <SideMenuItem
          name="Jobs"
          icon="job"
          to={projectPath(organization, project)}
          isSelected={false}
        />
        <SideMenuItem
          name="Integrations"
          icon="integration"
          to={projectIntegrationsPath(organization, project)}
          isSelected={false}
        />
        <SideMenuItem
          name="Environments"
          icon="environment"
          to={projectEnvironmentsPath(organization, project)}
          isSelected={false}
        />
      </div>
      <div className="flex flex-col">
        <SideMenuItem
          name="Team"
          icon="team"
          to={organizationTeamPath(organization)}
          isSelected={false}
        />
        <SideMenuItem
          name="Billing"
          icon="billing"
          to={organizationBillingPath(organization)}
          isSelected={false}
        />
        <SideMenuItem
          name="Account"
          icon="account"
          to={accountPath()}
          isSelected={false}
        />
      </div>
    </div>
  );
}

function SideMenuItem({
  icon,
  name,
  to,
  isSelected,
}: {
  icon: IconNames;
  name: string;
  to: string;
  isSelected: boolean;
}) {
  return (
    <NavLinkButton
      variant="menu-item"
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName="text-slate-400"
      to={to}
      className={({ isActive, isPending }) =>
        isActive ? "bg-slate-750 group-hover:bg-slate-750" : undefined
      }
    >
      {name}
    </NavLinkButton>
  );
}
