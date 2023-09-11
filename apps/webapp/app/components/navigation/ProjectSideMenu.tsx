import { useMatches } from "@remix-run/react";
import { motion } from "framer-motion";
import { useOptionalJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  accountPath,
  organizationBillingPath,
  organizationTeamPath,
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectSetupPath,
  projectPath,
  projectTriggersPath,
} from "~/utils/pathBuilder";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { NavLinkButton } from "../primitives/Buttons";
import { NamedIcon, type IconNames } from "../primitives/NamedIcon";
import { SimpleTooltip } from "../primitives/Tooltip";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full justify-stretch overflow-hidden">{children}</div>;
}

const expandedWith = "14rem";
const collapsedWith = "2.81rem";

const menuVariants = {
  expanded: {
    minWidth: expandedWith,
    width: expandedWith,
  },
  collapsed: {
    minWidth: collapsedWith,
    width: collapsedWith,
  },
};

export function ProjectSideMenu() {
  const organization = useOrganization();
  const project = useProject();
  const matches = useMatches();

  //the deepest route `handle` determines if the menu is expanded
  const deepestMatch = matches.at(-1);
  const handle = deepestMatch?.handle as Handle;
  const isCollapsed = handle?.expandSidebar ? !handle.expandSidebar : true;

  const job = useOptionalJob();
  const jobsActive =
    job !== undefined ||
    deepestMatch?.id === "routes/_app.orgs.$organizationSlug.projects.$projectParam._index";

  return (
    <motion.div
      animate={isCollapsed ? "collapsed" : "expanded"}
      variants={menuVariants}
      initial={isCollapsed ? "collapsed" : "expanded"}
      transition={{ type: "spring", duration: 0.5 }}
      className={cn(
        "flex h-full flex-col justify-between overflow-hidden border-r border-uiBorder p-1 transition"
      )}
    >
      <div className="flex flex-col gap-1">
        <SideMenuItem
          name="Jobs"
          icon="job"
          to={projectPath(organization, project)}
          isCollapsed={isCollapsed}
          forceActive={jobsActive}
          data-action="jobs"
        />
        <SideMenuItem
          name="Integrations"
          icon="integration"
          to={projectIntegrationsPath(organization, project)}
          isCollapsed={isCollapsed}
          hasWarning={project.hasUnconfiguredIntegrations}
          data-action="integrations"
        />
        <SideMenuItem
          name="Triggers"
          icon="trigger"
          to={projectTriggersPath(organization, project)}
          isCollapsed={isCollapsed}
          hasWarning={project.hasInactiveExternalTriggers}
          data-action="triggers"
        />
        <SideMenuItem
          name="Environments & API Keys"
          icon="environment"
          to={projectEnvironmentsPath(organization, project)}
          isCollapsed={isCollapsed}
          data-action="environments & api keys"
        />
      </div>
      <div className="flex flex-col">
        <SideMenuItem
          name="Team"
          icon="team"
          to={organizationTeamPath(organization)}
          isCollapsed={isCollapsed}
          data-action="team"
        />
        <SideMenuItem
          name="Usage & Billing"
          icon="billing"
          to={organizationBillingPath(organization)}
          isCollapsed={isCollapsed}
          data-action="usage & billing"
        />
        <SideMenuItem
          name="Onboarding"
          icon="clipboard-checked"
          to={projectSetupPath(organization, project)}
          isCollapsed={isCollapsed}
          data-action="onboarding"
        />
        <SideMenuItem
          name="Account"
          icon={UserProfilePhoto}
          to={accountPath()}
          isCollapsed={isCollapsed}
          data-action="account"
        />
      </div>
    </motion.div>
  );
}

const itemVariants = {
  expanded: {
    opacity: 1,
  },
  collapsed: {
    opacity: 0,
  },
};

function SideMenuItem({
  icon,
  name,
  to,
  isCollapsed,
  forceActive,
  hasWarning = false,
}: {
  icon: IconNames | React.ComponentType<any>;
  name: string;
  to: string;
  isCollapsed: boolean;
  hasWarning?: boolean;
  forceActive?: boolean;
}) {
  return (
    <SimpleTooltip
      button={
        <NavLinkButton
          variant="menu-item"
          fullWidth
          textAlignLeft
          LeadingIcon={icon}
          leadingIconClassName="text-dimmed"
          to={to}
          className={({ isActive, isPending }) => {
            if (forceActive !== undefined) {
              isActive = forceActive;
            }
            return cn(
              "relative",
              isActive
                ? "bg-slate-800 text-bright group-hover:bg-slate-800"
                : "text-dimmed group-hover:bg-slate-850 group-hover:text-bright"
            );
          }}
        >
          <motion.span
            className="shrink-0 pl-1"
            animate={isCollapsed ? "collapsed" : "expanded"}
            variants={itemVariants}
            initial={isCollapsed ? "collapsed" : "expanded"}
          >
            {name}
          </motion.span>
          {hasWarning && <NamedIcon name="error" className="absolute left-1 top-1 h-4 w-4" />}
        </NavLinkButton>
      }
      content={name}
      side="right"
      hidden={!isCollapsed}
    />
  );
}
