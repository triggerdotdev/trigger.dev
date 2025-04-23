import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
import { EnvironmentCombo } from "../environments/EnvironmentLabel";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";

export function EnvironmentSelector({
  organization,
  project,
  environment,
  className,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  className?: string;
}) {
  const { isManagedCloud } = useFeatures();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { urlForEnvironment } = useEnvironmentSwitcher();

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  const hasStaging = project.environments.some((env) => env.type === "STAGING");

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <PopoverArrowTrigger
        isOpen={isMenuOpen}
        overflowHidden
        fullWidth
        className={cn("h-7 overflow-hidden py-1 pl-1.5", className)}
      >
        <EnvironmentCombo environment={environment} className="w-full text-2sm" />
      </PopoverArrowTrigger>
      <PopoverContent
        className="min-w-[14rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-1 p-1">
          {project.environments.map((env) => (
            <PopoverMenuItem
              key={env.id}
              to={urlForEnvironment(env)}
              title={<EnvironmentCombo environment={env} className="mx-auto grow text-2sm" />}
              isSelected={env.id === environment.id}
            />
          ))}
        </div>
        {!hasStaging && isManagedCloud && (
          <>
            <PopoverSectionHeader title="Additional environments" />
            <div className="p-1">
              <PopoverMenuItem
                key="staging"
                to={v3BillingPath(
                  organization,
                  "Upgrade to unlock a Staging environment for your projects."
                )}
                title={
                  <div className="flex w-full items-center justify-between">
                    <EnvironmentCombo environment={{ type: "STAGING" }} className="text-2sm" />
                    <span className="text-indigo-500">Upgrade</span>
                  </div>
                }
                isSelected={false}
              />
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
