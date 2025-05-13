import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ChevronRightIcon, Cog8ToothIcon, PlusIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization, type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { branchesPath, docsPath, v3BillingPath } from "~/utils/pathBuilder";
import { EnvironmentCombo } from "../environments/EnvironmentLabel";
import { Button, ButtonContent } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Fieldset } from "../primitives/Fieldset";
import { FormButtons } from "../primitives/FormButtons";
import { FormError } from "../primitives/FormError";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { schema } from "~/routes/resources.branches.new";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { Header2 } from "../primitives/Headers";
import { TextLink } from "../primitives/TextLink";

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
          {project.environments
            .filter((env) => env.branchName === null)
            .map((env) => {
              switch (env.isBranchableEnvironment) {
                case true: {
                  const branchEnvironments = project.environments.filter(
                    (e) => e.parentEnvironmentId === env.id
                  );
                  return (
                    <Branches
                      key={env.id}
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
                      title={
                        <EnvironmentCombo environment={env} className="mx-auto grow text-2sm" />
                      }
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
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
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
                  title={<span className="block text-preview">{env.branchName}</span>}
                  icon={<BranchEnvironmentIconSmall className="size-4 text-preview" />}
                  isSelected={env.id === currentEnvironment.id}
                />
              ))}
            </div>
          ) : (
            <div className="flex max-w-sm flex-col gap-1 p-3">
              <div className="flex items-center gap-1">
                <BranchEnvironmentIconSmall className="size-4 text-preview" />
                <Header2>Create your first branch</Header2>
              </div>
              <Paragraph spacing variant="small">
                Branches are a way to test new features in isolation before merging them into the
                main environment.
              </Paragraph>
              <Paragraph variant="small">
                Branches are only available when using v4 or above. Read our{" "}
                <TextLink to={docsPath("upgrade-to-v4")}>v4 upgrade guide</TextLink> to learn more.
              </Paragraph>
            </div>
          )}
          <div className="border-t border-charcoal-700 p-1">
            <PopoverMenuItem
              to={branchesPath(organization, project, environment)}
              title="Manage branches"
              icon={<Cog8ToothIcon className="size-4 text-text-dimmed" />}
              leadingIconClassName="text-text-dimmed"
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}
