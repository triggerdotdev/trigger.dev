import * as Ariakit from "@ariakit/react";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { SelectItem, SelectPopover, SelectProvider } from "~/components/primitives/Select";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import type { QueryScope } from "~/services/queryService.server";
import { CubeTransparentIcon, GlobeAltIcon } from "@heroicons/react/20/solid";
import { IconListLetters } from "@tabler/icons-react";

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

export function ScopeFilter() {
  const { value, replace } = useSearchParams();
  const scope = (value("scope") as QueryScope) ?? "environment";

  const handleChange = (newScope: string) => {
    replace({ scope: newScope === "environment" ? undefined : newScope });
  };

  return (
    <SelectProvider value={scope} setValue={handleChange}>
      <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
        <AppliedFilter
          label="Scope"
          icon={<CubeTransparentIcon className="size-4" />}
          value={<ScopeItem scope={scope} />}
          removable={false}
          variant="secondary/small"
        />
      </Ariakit.Select>
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        {scopeOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <ScopeItem scope={option.value} />
          </SelectItem>
        ))}
      </SelectPopover>
    </SelectProvider>
  );
}

function ScopeItem({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return `Org: ${organization.title}`;
    case "project":
      return `Project: ${project.name}`;
    case "environment":
      return <EnvironmentLabel environment={environment} />;
    default:
      return scope;
  }
}
