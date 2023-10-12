import { cn } from "~/utils/cn";
import { accountPath } from "~/utils/pathBuilder";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { NavLinkButton } from "../primitives/Buttons";
import { NamedIcon, type IconNames } from "../primitives/NamedIcon";
import { SimpleTooltip } from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full justify-stretch overflow-hidden">{children}</div>;
}

export function SideMenu() {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-uiBorder transition"
      )}
    >
      <div className="flex h-full flex-col justify-between">
        <div className="space-y-8 p-1">
          <div className="flex flex-col gap-1">
            <SideMenuItem name="Jobs" icon="job" to="" data-action="jobs" />
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to=""
              data-action="integrations"
              hasWarning
            />
            <SideMenuItem name="Triggers" icon="trigger" to="" data-action="triggers" />
            <SideMenuItem
              name="Environments & API Keys"
              icon="environment"
              to=""
              data-action="environments & api keys"
            />
          </div>
          <div className="flex flex-col gap-1">
            <SideMenuItem name="Jobs" icon="job" to="" data-action="jobs" />
            <SideMenuItem
              name="Integrations"
              icon="integration"
              to=""
              data-action="integrations"
              hasWarning
            />
            <SideMenuItem name="Triggers" icon="trigger" to="" data-action="triggers" />
            <SideMenuItem
              name="Environments & API Keys"
              icon="environment"
              to=""
              data-action="environments & api keys"
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

function SideMenuItem({
  icon,
  name,
  to,
  forceActive = false,
  hasWarning = false,
  target,
}: {
  icon: IconNames | React.ComponentType<any>;
  name: string;
  to: string;
  hasWarning?: boolean;
  forceActive?: boolean;
  target?: string;
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
          target={target}
          className={({ isActive, isPending }) => {
            if (forceActive !== undefined) {
              isActive = forceActive;
            }
            return cn(
              "",
              isActive || isPending
                ? "bg-slate-800 text-bright group-hover:bg-slate-800"
                : "text-dimmed group-hover:bg-slate-850 group-hover:text-bright"
            );
          }}
        >
          {name}
          {hasWarning && <Icon icon="error" className="h-5 w-5" />}
        </NavLinkButton>
      }
      content={name}
      side="right"
    />
  );
}
