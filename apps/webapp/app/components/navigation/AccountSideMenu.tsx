import { Link } from "@remix-run/react";
import { User } from "@trigger.dev/database";
import { cn } from "~/utils/cn";
import { accountPath, personalAccessTokensPath, rootPath } from "~/utils/pathBuilder";
import { Header3 } from "../primitives/Headers";
import { ArrowLeftIcon, ChevronLeftIcon } from "@heroicons/react/24/solid";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { DiscordIcon } from "@trigger.dev/companyicons";
import { Feedback } from "../Feedback";
import { Button } from "../primitives/Buttons";
import { ShieldCheckIcon } from "@heroicons/react/20/solid";

export function AccountSideMenu({ user }: { user: User }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-ui-border transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "flex h-10 items-center justify-between border-b bg-background px-1 py-1 transition"
          )}
        >
          <Link to={rootPath()} className="flex w-full items-center gap-1">
            <ArrowLeftIcon className="h-5 w-5 text-slate-400" />
            <Header3>Account</Header3>
          </Link>
        </div>
        <div className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div className="mb-6 flex flex-col gap-1 px-1">
            <SideMenuHeader title={user.name ?? user.displayName ?? user.email} />

            <SideMenuItem
              name="Your profile"
              icon="account"
              iconColor="text-indigo-500"
              to={accountPath()}
              data-action="account"
            />
          </div>
          <div className="mb-1 flex flex-col gap-1 px-1">
            <SideMenuHeader title="Security" />
            <SideMenuItem
              name="Personal Access Tokens"
              icon={ShieldCheckIcon}
              iconColor="text-emerald-500"
              to={personalAccessTokensPath()}
              data-action="tokens"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border p-1">
          <SideMenuItem
            name="Join our Discord"
            icon={DiscordIcon}
            to="https://trigger.dev/discord"
            data-action="join our discord"
            target="_blank"
          />

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

          <Feedback
            button={
              <Button
                variant="small-menu-item"
                LeadingIcon="log"
                data-action="help & feedback"
                fullWidth
                textAlignLeft
              >
                Help & Feedback
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
