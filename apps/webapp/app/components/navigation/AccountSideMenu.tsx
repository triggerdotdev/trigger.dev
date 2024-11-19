import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { ArrowLeftIcon } from "@heroicons/react/24/solid";
import { User } from "@trigger.dev/database";
import { useFeatures } from "~/hooks/useFeatures";
import { cn } from "~/utils/cn";
import { accountPath, personalAccessTokensPath, rootPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";

export function AccountSideMenu({ user }: { user: User }) {
  const { v3Enabled } = useFeatures();

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-grid-bright bg-background-bright transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div className={cn("flex h-10 items-center justify-between border-b p-1 transition")}>
          <LinkButton
            variant="minimal/medium"
            LeadingIcon={ArrowLeftIcon}
            to={rootPath()}
            fullWidth
            textAlignLeft
          >
            Account
          </LinkButton>
        </div>
        <div className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="mb-6 flex flex-col gap-1 px-1">
            <SideMenuHeader title={user.name ?? user.displayName ?? user.email} />

            <SideMenuItem
              name="Your profile"
              icon="account"
              activeIconColor="text-indigo-500"
              to={accountPath()}
              data-action="account"
            />
          </div>
          {v3Enabled && (
            <div className="mb-1 flex flex-col gap-1 px-1">
              <SideMenuHeader title="Security" />
              <SideMenuItem
                name="Personal Access Tokens"
                icon={ShieldCheckIcon}
                activeIconColor="text-emerald-500"
                to={personalAccessTokensPath()}
                data-action="tokens"
              />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          <HelpAndFeedback />
        </div>
      </div>
    </div>
  );
}
