import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { FullEnvironmentCombo } from "../environments/EnvironmentLabel";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
} from "../primitives/Popover";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { cn } from "~/utils/cn";

export function EnvironmentSelector({
  project,
  environment,
  className,
}: {
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  className?: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { urlForEnvironment } = useEnvironmentSwitcher();

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <PopoverArrowTrigger
        isOpen={isMenuOpen}
        overflowHidden
        className={cn("h-7 w-full overflow-hidden py-1 pl-2", className)}
      >
        <FullEnvironmentCombo environment={environment} className="text-2sm" />
      </PopoverArrowTrigger>
      <PopoverContent
        className="overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        {project.environments.map((env) => (
          <PopoverMenuItem
            key={env.id}
            to={urlForEnvironment(env)}
            title={<FullEnvironmentCombo environment={env} className="text-2sm" />}
            isSelected={env.id === environment.id}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
