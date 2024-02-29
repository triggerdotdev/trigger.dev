import { ReactNode } from "react";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { plansPath } from "~/utils/pathBuilder";
import { UpgradePrompt, useShowUpgradePrompt } from "../billing/UpgradePrompt";
import { PageNavigationIndicator } from "./PageNavigationIndicator";

type NavBar = {
  children?: ReactNode;
};

function NavBar() {
  return (
    <div>
      <div className="flex h-10 w-full items-center justify-between border-b border-grid-bright bg-background-bright">
        <div className="flex h-full items-center gap-4">
          <PageNavigationIndicator className="mr-2" />
        </div>
      </div>
    </div>
  );
}

export type MainBodyProps = {
  organization?: MatchedOrganization;
  children: ReactNode;
};

export function MainBody({ organization, children }: MainBodyProps) {
  const showUpgradePrompt = useShowUpgradePrompt(organization);

  return (
    <div
      className={cn(
        "grid overflow-hidden",
        showUpgradePrompt.shouldShow ? "grid-rows-[2.5rem_2.5rem_1fr]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <NavBar />
      {showUpgradePrompt.shouldShow && organization && (
        <UpgradePrompt
          runsEnabled={showUpgradePrompt.runsEnabled}
          runCountCap={showUpgradePrompt.runCountCap}
          planPath={plansPath(organization)}
        />
      )}
      {children}
    </div>
  );
}
