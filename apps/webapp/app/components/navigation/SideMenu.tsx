import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { LogoIcon } from "../LogoIcon";
import { UserAvatar } from "../UserProfilePhoto";
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

export function SideMenu() {
  const borderRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      if (borderRef.current) {
        setIsScrolled(borderRef.current.scrollTop > 0);
      }
    };

    borderRef.current?.addEventListener("scroll", handleScroll);
    return () => borderRef.current?.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-uiBorder transition scrollbar-hide"
      )}
    >
      <div className="flex h-full flex-col justify-between">
        <SideMenuOrgHeader
          className={cn(
            "border-b px-1 transition",
            isScrolled ? " border-border" : "border-transparent"
          )}
        />
        <div className="overflow-hidden overflow-y-auto pt-4" ref={borderRef}>
          <div>
            <SideMenuHeader title="My Project 1" />
            <SideMenuItem name="Jobs" icon="job" count={33} to="" data-action="jobs" hasWarning />
            <SideMenuItem name="Runs" icon="integration" to="" data-action="runs" />
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
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title="My Org 1" />
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to=""
              count={3}
              data-action="integrations"
              hasWarning="An Integration requires setup"
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

function SideMenuOrgHeader({ className }: { className?: string }) {
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const [isProfileMenuOpen, setProfileMenuOpen] = useState(false);
  return (
    <div className={cn("flex items-center justify-between bg-background px-0 py-1", className)}>
      <Popover onOpenChange={(open) => setOrgMenuOpen(open)}>
        <PopoverArrowTrigger fullWidth isOpen={isOrgMenuOpen} className="h-7 py-1 pl-2 pr-2">
          <LogoIcon className="relative -top-px mr-2 h-4 w-4" />
          My Org 1
        </PopoverArrowTrigger>
        <PopoverContent
          className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) / 2)` }}
        >
          <Fragment>
            <PopoverSectionHeader title="My Org 1" />
            <div className="flex flex-col gap-1 p-1">
              <PopoverMenuItem to="#" title="My Project 1" isSelected={true} icon="folder" />
              <PopoverMenuItem to="#" title="My Project 2" icon="folder" />
              <PopoverMenuItem to="#" title="My Project 3" icon="folder" />
              <PopoverMenuItem to="#" title="New Project" icon="plus" />
            </div>
            <PopoverSectionHeader title="My Org 2" />
            <div className="flex flex-col gap-1 p-1">
              <PopoverMenuItem to="#" title="My Project a" icon="folder" />
              <PopoverMenuItem to="#" title="My Project b" icon="folder" />
              <PopoverMenuItem to="#" title="My Project c" icon="folder" />
              <PopoverMenuItem to="#" title="New Project" icon="plus" />
            </div>
          </Fragment>
          <div className="border-t border-slate-800 p-1">
            <PopoverMenuItem to="#" title="New Organization" icon="plus" />
          </div>
        </PopoverContent>
      </Popover>
      <div>
        <Popover onOpenChange={(open) => setProfileMenuOpen(open)}>
          <PopoverCustomTrigger isOpen={isProfileMenuOpen} className="p-1">
            <UserAvatar className="h-5 w-5 text-slate-600" />
          </PopoverCustomTrigger>
          <PopoverContent
            className="min-w-[20rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
            align="start"
          >
            <Fragment>
              <PopoverSectionHeader title="james@trigger.dev" variant="extra-small" />
              <div className="flex flex-col gap-1 p-1">
                <PopoverMenuItem to="#" title="View profile" icon="avatar" />
                <PopoverMenuItem to="#" title="Log out" icon="logout" />
              </div>
            </Fragment>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function SideMenuHeader({ title }: { title: string }) {
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
  hasWarning,
  count,
  target,
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
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
          {typeof hasWarning === "string" ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon="error" className="h-5 w-5" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1 border border-rose-500 bg-rose-500/20 backdrop-blur-xl">
                  {hasWarning}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            hasWarning && <Icon icon="error" className="h-5 w-5" />
          )}
        </div>
      </div>
    </NavLinkButton>
  );
}

function MenuCount({ count }: { count: number }) {
  return <div className="rounded-full bg-slate-900 px-2 py-1 text-xxs text-dimmed">{count}</div>;
}
