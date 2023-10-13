import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { LogoIcon } from "../LogoIcon";
import { NavLinkButton } from "../primitives/Buttons";
import { Icon } from "../primitives/Icon";
import { type IconNames } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { SimpleTooltip } from "../primitives/Tooltip";
import { UserAvatar } from "../UserProfilePhoto";

export function SideMenu() {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-uiBorder transition"
      )}
    >
      <div className="flex h-full flex-col justify-between">
        <div className="overflow-y-auto px-1 pb-0">
          <SideMenuOrgHeader />
          <div className={cn("mb-8 mt-2 flex flex-col gap-y-1")}>
            <SideMenuHeader title="My Project 1" />
            <SideMenuItem name="Jobs" icon="job" count={33} to="" data-action="jobs" />
            <SideMenuItem name="Runs" icon="integration" to="" data-action="runs" hasWarning />
            <SideMenuItem name="Events" icon="trigger" to="" data-action="events" />
            <SideMenuItem name="Custom" to="" data-action="custom" subItem />
            <SideMenuItem name="Webhooks" to="" data-action="webhooks" subItem />
            <SideMenuItem name="Triggers" icon="trigger" count={4} to="" data-action="triggers" />
            <SideMenuItem name="Catalog" icon="trigger" count={4} to="" data-action="catalog" />
            <SideMenuItem name="User Events" to="" subItem />
            <SideMenuItem name="Billing Events" to="" subItem />
            <SideMenuItem name="Endpoints" icon="trigger" count={4} to="" data-action="endpoints" />
            <SideMenuItem name="job-catalog" to="" subItem />
            <SideMenuItem name="API Keys" icon="environment" to="" data-action="api keys" />
          </div>
          <div className="flex flex-col gap-1">
            <SideMenuHeader title="My Org 1" />
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to=""
              count={3}
              data-action="integrations"
              hasWarning
            />
            <SideMenuItem name="Projects" icon="job" to="" data-action="projects" />
            <SideMenuItem name="Team" icon="trigger" to="" data-action="team" />
            <SideMenuItem
              name="Usage & Billing"
              icon="environment"
              to=""
              data-action="usage & billing"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border p-1">
          <SideMenuItem
            name="Changelog"
            icon="star"
            to="https://trigger.dev/changelog"
            data-action="changelog"
            target="_blank"
          />
          <SideMenuItem
            name="Documentation"
            icon="docs"
            to="https://trigger.dev/docs"
            data-action="documentation"
            target="_blank"
          />
          <SideMenuItem name="Help & Feedback" icon="log" to="" data-action="help & feedback" />
        </div>
      </div>
    </div>
  );
}

function SideMenuOrgHeader() {
  return (
    <div className="sticky top-0 flex items-center justify-between bg-background px-2 py-3">
      <div className="flex items-center gap-2">
        <LogoIcon className="h-4 w-4" />
        <Paragraph variant="extra-small">My Org 1</Paragraph>
      </div>
      <div>
        <UserAvatar className="h-5 w-5 text-slate-600" />
      </div>
    </div>
  );
}

function SideMenuHeader({ title, menuItems }: { title: string; menuItems?: React.ReactNode }) {
  return (
    <div className="group flex items-center justify-between px-1.5">
      <Paragraph variant="extra-extra-small/caps" className="cursor-default text-slate-500">
        {title}
      </Paragraph>
      <div>
        <EllipsisHorizontalIcon className="trasition h-4 w-4 text-slate-500 group-hover:text-bright" />
      </div>
    </div>
  );
}

function SideMenuItem({
  icon,
  name,
  to,
  forceActive = false,
  hasWarning = false,
  count,
  target,
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
  name: string;
  to: string;
  hasWarning?: boolean;
  count?: number;
  forceActive?: boolean;
  target?: string;
  subItem?: boolean;
}) {
  return (
    <SimpleTooltip
      button={
        <NavLinkButton
          variant={subItem ? "side-menu-sub-item" : "side-menu-item"}
          fullWidth
          textAlignLeft
          LeadingIcon={icon}
          leadingIconClassName="text-dimmed"
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
          <div className="flex w-full items-center justify-between">
            {name}
            <div className="flex items-center gap-1">
              {count && <MenuCount count={count} />}
              {hasWarning && <Icon icon="error" className="h-5 w-5" />}
            </div>
          </div>
        </NavLinkButton>
      }
      content={name}
      side="right"
    />
  );
}

function MenuCount({ count }: { count: number }) {
  return <div className="rounded-full bg-slate-900 px-2 py-1 text-xxs text-dimmed">{count}</div>;
}
