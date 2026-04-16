import * as Ariakit from "@ariakit/react";
import { FolderIcon } from "@heroicons/react/20/solid";
import { useRef } from "react";
import { EnvironmentIcon, EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Avatar } from "~/components/primitives/Avatar";
import { SelectItem, SelectPopover, SelectProvider } from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import type { QueryScope } from "~/services/queryService.server";

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

export function ScopeFilter({ shortcut }: { shortcut?: ShortcutDefinition } = {}) {
  const { value, replace } = useSearchParams();
  const scope = (value("scope") as QueryScope) ?? "environment";
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleChange = (newScope: string) => {
    replace({ scope: newScope === "environment" ? undefined : newScope });
  };

  useShortcutKeys({
    shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
    disabled: !shortcut,
  });

  return (
    <SelectProvider value={scope} setValue={handleChange}>
      <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
        <Ariakit.TooltipAnchor
          render={
            <Ariakit.Select
              ref={triggerRef as any}
              render={<div className="group cursor-pointer focus-custom" />}
            />
          }
        >
          <AppliedFilter
            label="Scope"
            value={<ScopeItem scope={scope} />}
            removable={false}
            variant="secondary/small"
          />
        </Ariakit.TooltipAnchor>
        {shortcut && (
          <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright py-1.5 pl-2.5 pr-3 text-xs text-text-dimmed">
            <div className="flex items-center gap-3">
              <span>Change scope</span>
              <ShortcutKey className="size-4 flex-none" shortcut={shortcut} variant="small" />
            </div>
          </Ariakit.Tooltip>
        )}
      </Ariakit.TooltipProvider>
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        {scopeOptions.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="gap-x-2 text-text-bright"
            icon={<ScopeIcon scope={option.value} />}
          >
            <ScopeLabel scope={option.value} />
          </SelectItem>
        ))}
      </SelectPopover>
    </SelectProvider>
  );
}

function ScopeIcon({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return <Avatar avatar={organization.avatar} size={1} orgName={organization.title} />;
    case "project":
      return <FolderIcon className="size-4 text-indigo-500" />;
    case "environment":
      return <EnvironmentIcon environment={environment} className="size-4" />;
    default:
      return null;
  }
}

function ScopeLabel({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return <span className="text-text-bright">{organization.title}</span>;
    case "project":
      return <span className="text-text-bright">{project.name}</span>;
    case "environment":
      return <EnvironmentLabel environment={environment} disableTooltip />;
    default:
      return scope;
  }
}

function ScopeItem({ scope }: { scope: QueryScope }) {
  return (
    <span className="flex items-center gap-1">
      <ScopeIcon scope={scope} />
      <ScopeLabel scope={scope} />
    </span>
  );
}
