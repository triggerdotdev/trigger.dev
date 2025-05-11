import { useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { newOrganizationPath, v3BillingPath, v3EnvironmentPath } from "~/utils/pathBuilder";
import { EnvironmentCombo } from "../environments/EnvironmentLabel";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { ButtonContent } from "../primitives/Buttons";
import { ChevronRightIcon, PlusIcon } from "@heroicons/react/20/solid";
import { GitBranchIcon } from "lucide-react";
import { Paragraph } from "../primitives/Paragraph";

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
          {project.environments.map((env) => {
            switch (env.isBranchableEnvironment) {
              case true: {
                const branchEnvironments = project.environments.filter(
                  (e) => e.parentEnvironmentId === env.id
                );
                return (
                  <Branches
                    parentEnvironment={env}
                    branchEnvironments={branchEnvironments}
                    currentEnvironment={environment}
                  />
                );
              }
              case false:
                return (
                  <PopoverMenuItem
                    key={env.id}
                    to={urlForEnvironment(env)}
                    title={<EnvironmentCombo environment={env} className="mx-auto grow text-2sm" />}
                    isSelected={env.id === environment.id}
                  />
                );
            }
          })}
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
              <PopoverMenuItem
                key="preview"
                to={v3BillingPath(
                  organization,
                  "Upgrade to unlock Preview environments for your projects."
                )}
                title={
                  <div className="flex w-full items-center justify-between">
                    <EnvironmentCombo environment={{ type: "PREVIEW" }} className="text-2sm" />
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

function Branches({
  parentEnvironment,
  branchEnvironments,
  currentEnvironment,
}: {
  parentEnvironment: SideMenuEnvironment;
  branchEnvironments: SideMenuEnvironment[];
  currentEnvironment: SideMenuEnvironment;
}) {
  const { urlForEnvironment } = useEnvironmentSwitcher();
  const navigation = useNavigation();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setMenuOpen(true);
  };

  const handleMouseLeave = () => {
    // Small delay before closing to allow moving to the content
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 150);
  };

  return (
    <Popover onOpenChange={(open) => setMenuOpen(open)} open={isMenuOpen}>
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className="hover:bg-charcoal-750"
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            <EnvironmentCombo environment={parentEnvironment} className="mx-auto grow text-2sm" />
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {branchEnvironments.length > 0 ? (
            <div className="flex flex-col gap-1 p-1">
              {branchEnvironments.map((env) => (
                <PopoverMenuItem
                  key={env.id}
                  to={urlForEnvironment(env)}
                  title={env.branchName}
                  icon={<GitBranchIcon className="size-4 text-text-dimmed" />}
                  leadingIconClassName="text-text-dimmed"
                  isSelected={env.id === currentEnvironment.id}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-1">
              <Paragraph variant="small">No branches found</Paragraph>
            </div>
          )}
          <div className="border-t border-charcoal-700 p-1">
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New branch"
              icon={PlusIcon}
              leadingIconClassName="text-text-dimmed"
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}
