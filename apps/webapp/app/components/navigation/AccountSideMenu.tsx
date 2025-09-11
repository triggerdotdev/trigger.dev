import { LockClosedIcon, ShieldCheckIcon, UserCircleIcon } from "@heroicons/react/20/solid";
import { ArrowLeftIcon } from "@heroicons/react/24/solid";
import type { User } from "@trigger.dev/database";
import { cn } from "~/utils/cn";
import {
  accountPath,
  accountSecurityPath,
  personalAccessTokensPath,
  rootPath,
} from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";

export function AccountSideMenu({ user }: { user: User }) {
  return (
    <div
      className={cn(
        "grid h-full grid-rows-[2.5rem_auto_2.5rem] overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div className={cn("flex items-center justify-between p-1 transition")}>
        <LinkButton
          variant="minimal/medium"
          LeadingIcon={ArrowLeftIcon}
          to={rootPath()}
          fullWidth
          textAlignLeft
        >
          <span className="text-text-bright">Back to app</span>
        </LinkButton>
      </div>
      <div className="mb-6 flex grow flex-col gap-1 overflow-y-auto px-1 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <SideMenuHeader title="Account" />
        <SideMenuItem
          name="Profile"
          icon={UserCircleIcon}
          activeIconColor="text-indigo-500"
          to={accountPath()}
          data-action="account"
        />
        <SideMenuItem
          name="Personal Access Tokens"
          icon={ShieldCheckIcon}
          activeIconColor="text-emerald-500"
          to={personalAccessTokensPath()}
          data-action="tokens"
        />
        <SideMenuItem
          name="Security"
          icon={LockClosedIcon}
          activeIconColor="text-rose-500"
          to={accountSecurityPath()}
          data-action="security"
        />
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        <HelpAndFeedback />
      </div>
    </div>
  );
}
