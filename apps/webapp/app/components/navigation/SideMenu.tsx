import { ArrowRightOnRectangleIcon, EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import {
  BookmarkIcon,
  ChartPieIcon,
  QueueListIcon,
  UserGroupIcon,
  UserPlusIcon,
} from "@heroicons/react/24/solid";
import { IconExclamationCircle } from "@tabler/icons-react";
import { Fragment, useEffect, useRef, useState } from "react";
import simplur from "simplur";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { MatchedProject } from "~/hooks/useProject";
import { User } from "~/models/user.server";
import { cn } from "~/utils/cn";
import {
  accountPath,
  inviteTeamMemberPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationBillingPath,
  organizationTeamPath,
  projectEnvironmentsPath,
  projectIntegrationsPath,
  projectPath,
  projectSetupPath,
  projectTriggersPath,
} from "~/utils/pathBuilder";
import { LogoIcon } from "../LogoIcon";
import { UserAvatar, UserProfilePhoto } from "../UserProfilePhoto";
import { Badge } from "../primitives/Badge";
import { NavLinkButton } from "../primitives/Buttons";
import { Icon } from "../primitives/Icon";
import { type IconNames } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";

type SideMenuProps = {
  user: Pick<User, "email">;
  project: MatchedProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
};

export function SideMenu({ user, project, organization, organizations }: SideMenuProps) {
  const borderRef = useRef<HTMLDivElement>(null);
  const [showHeaderDivider, setShowHeaderDivider] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      if (borderRef.current) {
        const shouldShowHeaderDivider = borderRef.current.scrollTop > 1;
        if (showHeaderDivider !== shouldShowHeaderDivider) {
          setShowHeaderDivider(shouldShowHeaderDivider);
        }
      }
    };

    borderRef.current?.addEventListener("scroll", handleScroll);
    return () => borderRef.current?.removeEventListener("scroll", handleScroll);
  }, [showHeaderDivider]);

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-uiBorder transition scrollbar-hide"
      )}
    >
      <div className="flex h-full flex-col">
        <SideMenuOrgHeader
          className={cn(
            "border-b px-1 transition",
            showHeaderDivider ? " border-border" : "border-transparent"
          )}
          organization={organization}
          organizations={organizations}
          project={project}
          user={user}
        />
        <div className="h-full overflow-hidden overflow-y-auto pt-2" ref={borderRef}>
          <div className="mb-6 flex flex-col gap-1 px-1">
            <SideMenuHeader title={project.name || "No project found"}>
              <PopoverMenuItem
                to={projectSetupPath(organization, project)}
                title="Framework setup"
                icon="plus"
              />
            </SideMenuHeader>
            <SideMenuItem
              name="Jobs"
              forceActive
              icon="job"
              iconColor="text-indigo-500"
              count={33}
              to={projectPath(organization, project)}
              data-action="jobs"
              hasWarning
            />
            {/* // TODO Create a new "Runs" page: */}
            <SideMenuItem
              name="Runs"
              icon="runs"
              iconColor="text-lime-500"
              to="#"
              data-action="runs"
            />
            {/* // TODO Create a new "Events" page: */}
            <SideMenuItem
              name="Events"
              icon={BookmarkIcon}
              iconColor="text-orange-500"
              to="#"
              data-action="events"
            />
            <SideMenuItem name="Custom" to="" data-action="custom" subItem />
            <SideMenuItem name="Webhooks" to="" data-action="webhooks" subItem />
            <SideMenuItem
              name="Triggers"
              icon="trigger"
              iconColor="text-teal-500"
              to={projectTriggersPath(organization, project)}
              data-action="triggers"
              hasWarning={project.hasInactiveExternalTriggers}
            />
            <SideMenuItem
              name="Catalog"
              icon={QueueListIcon}
              iconColor="text-pink-500"
              count={4}
              to="#"
              data-action="catalog"
            />
            <SideMenuItem name="User Events" to="" subItem />
            <SideMenuItem name="Billing Events" to="" subItem />
            {/* // TODO I need to create this new "Endpoints" page: */}
            <SideMenuItem
              name="Endpoints"
              icon="endpoint"
              iconColor="text-blue-500"
              count={4}
              to="#"
              data-action="endpoints"
            />
            <SideMenuItem name="job-catalog" to="" subItem />
            <SideMenuItem
              name="API Keys"
              icon="environment"
              iconColor="text-yellow-500"
              to={projectEnvironmentsPath(organization, project)}
              data-action="environments & api keys"
            />
          </div>
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title="My Org 1">
              <PopoverMenuItem to={newProjectPath(organization)} title="New Project" icon="plus" />
              <PopoverMenuItem
                to={inviteTeamMemberPath(organization)}
                title="Invite team member"
                icon={UserPlusIcon}
                leadingIconClassName="text-indigo-500"
              />
            </SideMenuHeader>
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to={projectIntegrationsPath(organization, project)}
              count={projectIntegrationsPath.length}
              data-action="integrations"
              hasWarning={project.hasUnconfiguredIntegrations}
            />
            {/* // TODO I need to create this new "Projects" page: */}
            <SideMenuItem
              name="Projects"
              icon="folder"
              to={projectPath(organization, project)}
              data-action="projects"
            />
            <SideMenuItem
              name="Team"
              icon={UserGroupIcon}
              to={organizationTeamPath(organization)}
              data-action="team"
            />
            <SideMenuItem
              name="Usage & Billing"
              icon={ChartPieIcon}
              to={organizationBillingPath(organization)}
              data-action="usage & billing"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border p-1">
          <SideMenuItem
            name="Documentation"
            icon="docs"
            to="https://trigger.dev/docs"
            data-action="documentation"
            target="_blank"
          />
          <SideMenuItem
            name="Changelog"
            icon="star"
            to="https://trigger.dev/changelog"
            data-action="changelog"
            target="_blank"
          />
          {/* // TODO this Feedback component is not working in storybook */}
          {/* <Feedback
            button={
              <SideMenuItem name="Help & Feedback" icon="log" to="" data-action="help & feedback" />
            }
          /> */}
        </div>
      </div>
    </div>
  );
}

function SideMenuOrgHeader({
  className,
  project,
  organization,
  organizations,
  user,
}: {
  className?: string;
  project: MatchedProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  user: Pick<User, "email">;
}) {
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const [isProfileMenuOpen, setProfileMenuOpen] = useState(false);

  return (
    <div className={cn("flex items-center justify-between bg-background px-0 py-1", className)}>
      <Popover onOpenChange={(open) => setOrgMenuOpen(open)}>
        <PopoverArrowTrigger
          isOpen={isOrgMenuOpen}
          overflowHidden
          className="h-7 w-full justify-between overflow-hidden py-1 pl-2"
        >
          <LogoIcon className="relative -top-px mr-2 h-4 w-4 min-w-[1rem]" />
          <span className="truncate">{organization.title ?? "Select an organization"}</span>
        </PopoverArrowTrigger>
        <PopoverContent
          className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10%)` }}
        >
          {organizations.map((organization) => (
            <Fragment key={organization.id}>
              <PopoverSectionHeader title={organization.title} />
              <div className="flex flex-col gap-1 p-1">
                {organization.projects.map((p) => {
                  const isSelected = p.id === project.id;
                  return (
                    <PopoverMenuItem
                      key={p.id}
                      to={projectPath(organization, p)}
                      title={
                        <div className="flex w-full items-center justify-between pl-1 text-bright">
                          <span className="grow truncate text-left">{p.name}</span>
                          <Badge className="mr-0.5">{simplur`${p._count.jobs} job[|s]`}</Badge>
                        </div>
                      }
                      isSelected={isSelected}
                      icon="folder"
                    />
                  );
                })}
                <PopoverMenuItem
                  to={newProjectPath(organization)}
                  title="New Project"
                  icon="plus"
                />
              </div>
            </Fragment>
          ))}
          <div className="border-t border-slate-800 p-1">
            <PopoverMenuItem to={newOrganizationPath()} title="New Organization" icon="plus" />
          </div>
        </PopoverContent>
      </Popover>
      <Popover onOpenChange={(open) => setProfileMenuOpen(open)}>
        <PopoverCustomTrigger isOpen={isProfileMenuOpen} className="p-1">
          <UserAvatar className="h-5 w-5 text-slate-600" />
        </PopoverCustomTrigger>
        <PopoverContent
          className="min-w-[12rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
        >
          <Fragment>
            <PopoverSectionHeader title={user.email} variant="extra-small" />
            <div className="flex flex-col gap-1 p-1">
              <PopoverMenuItem
                to={accountPath()}
                title="View profile"
                icon={UserProfilePhoto}
                leadingIconClassName="text-indigo-500"
              />
              <PopoverMenuItem
                to={logoutPath()}
                title="Log out"
                icon={ArrowRightOnRectangleIcon}
                leadingIconClassName="text-rose-500"
              />
            </div>
          </Fragment>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SideMenuHeader({ title, children }: { title: string; children: React.ReactNode }) {
  const [isProjectMenuOpen, setProfileMenuOpen] = useState(false);
  return (
    <div className="group flex items-center justify-between pl-1.5">
      <Paragraph
        variant="extra-extra-small/caps"
        className="cursor-default truncate text-slate-500"
      >
        {title}
      </Paragraph>
      <Popover onOpenChange={(open) => setProfileMenuOpen(open)}>
        <PopoverCustomTrigger isOpen={isProjectMenuOpen} className="p-1">
          <EllipsisHorizontalIcon className="h-4 w-4 text-slate-500 transition group-hover:text-bright" />
        </PopoverCustomTrigger>
        <PopoverContent
          className="min-w-max overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
        >
          <Fragment>
            <div className="flex flex-col gap-1 p-1">{children}</div>
          </Fragment>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SideMenuItem({
  icon,
  iconColor,
  name,
  to,
  forceActive = false,
  hasWarning,
  count,
  target,
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
  iconColor?: string;
  name: string;
  to: string;
  hasWarning?: string | boolean;
  count?: number;
  forceActive?: boolean;
  target?: string;
  subItem?: boolean;
}) {
  return (
    <NavLinkButton
      variant={subItem ? "small-menu-sub-item" : "small-menu-item"}
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName={forceActive ? iconColor : "text-dimmed"}
      to={to}
      target={target}
      className={({ isActive, isPending }) => {
        if (forceActive !== undefined) {
          isActive = forceActive;
        }
        return cn(
          "text-bright",
          subItem ? "text-dimmed" : "",
          isActive || isPending
            ? "bg-slate-850 text-bright group-hover:bg-slate-850"
            : "group-hover:bg-slate-850 group-hover:text-bright"
        );
      }}
    >
      <div className="flex w-full items-center justify-between overflow-hidden">
        <span className="truncate">{name}</span>
        <div className="flex items-center gap-1">
          {count && <MenuCount count={count} />}
          {typeof hasWarning === "string" ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1 border border-rose-500 bg-rose-500/20 backdrop-blur-xl">
                  {hasWarning}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            hasWarning && <Icon icon={IconExclamationCircle} className="h-5 w-5 text-rose-500" />
          )}
        </div>
      </div>
    </NavLinkButton>
  );
}

function MenuCount({ count }: { count: number }) {
  return <div className="rounded-full bg-slate-900 px-2 py-1 text-xxs text-dimmed">{count}</div>;
}
