import { XMarkIcon } from "@heroicons/react/20/solid";
import { type ReactNode, useEffect, useState } from "react";
import { environmentTextClassName } from "~/components/environments/EnvironmentLabel";
import { auditLogMenuSearch } from "./auditLogEvents";
import { useTypedFetcher } from "remix-typedjson";
import { Select, SelectItem } from "~/components/primitives/Select";
import type { ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { useOrganization } from "~/hooks/useOrganizations";
import type {
  AuditLogMenu,
  AuditLogMenuEnvironment,
  AuditLogMenuItem,
} from "~/presenters/v3/auditLogMenus.server";
import type { loader as menuLoader } from "~/routes/resources.orgs.$organizationSlug.audit-log.filter-options";
import { organizationAuditLogFilterOptionsPath } from "~/utils/pathBuilder";

export const ANY = "any";

/** A label whose environment name, at its end, is coloured as elsewhere in the app. */
function MenuLabel({
  label,
  environment,
}: {
  label: string;
  environment?: AuditLogMenuEnvironment;
}) {
  if (!environment || !label.endsWith(environment.name)) return <span>{label}</span>;
  return (
    <span>
      {label.slice(0, label.length - environment.name.length)}
      <span className={environmentTextClassName(environment)}>{environment.name}</span>
    </span>
  );
}

/**
 * A filter as the runs and logs pages show one: a plain button until it's set, then a
 * "Label: value" chip whose ✕ clears it. The chip still opens the menu.
 */
export function FilterChip({
  isSet,
  onClear,
  clearLabel,
  children,
}: {
  isSet: boolean;
  onClear: () => void;
  clearLabel: string;
  children: ReactNode;
}): ReactNode {
  if (!isSet) return children;
  return (
    <div className="flex h-6 items-center rounded border border-border-bright/50 bg-secondary text-xs shadow-xs divide-x divide-black/15 hover:bg-background-raised">
      {children}
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="flex size-6 items-center justify-center text-text-bright focus-custom"
      >
        <XMarkIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** A chip's trigger text: the filter's name, then its value once set. */
export function chipText(label: string, value: ReactNode | undefined): ReactNode {
  if (value === undefined) return label;
  return (
    <span>
      <span className="text-text-bright">{label}:</span>{" "}
      <span className="text-text-dimmed">{value}</span>
    </span>
  );
}

/** The trigger inside a set chip: the chip draws the box. */
export const CHIP_TRIGGER_CLASS = "border-0 bg-transparent shadow-none hover:bg-transparent pr-1";

/** How long typing pauses before a search is sent. */
const SEARCH_DELAY_MS = 250;

/**
 * A filter menu whose items come from the server a page at a time: its first items when it opens,
 * and matches as you type. The picked value keeps its name even when it isn't among them.
 */
export function AuditLogSearchMenu({
  menu,
  label,
  shortcut,
  heading,
  project,
  value,
  selectedLabel,
  selectedEnvironment,
  anyLabel,
  missingLabel,
  onChange,
}: {
  menu: AuditLogMenu;
  /** The filter's name on its chip. */
  label: string;
  /** Opens the menu, as other filter bars' shortcuts do. */
  shortcut?: ShortcutDefinition;
  /** The search box's placeholder, as other filter menus have. */
  heading?: string;
  /** Environments and keys are listed for this project. */
  project?: string;
  value: string | undefined;
  /** The picked value's name, resolved by the page. */
  selectedLabel: string | undefined;
  /** The picked environment's name within `selectedLabel`, to colour. */
  selectedEnvironment?: AuditLogMenuEnvironment;
  anyLabel: string;
  /** Shown for a picked value that no longer exists. */
  missingLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  const organization = useOrganization();
  const fetcher = useTypedFetcher<typeof menuLoader>();
  const { load } = fetcher;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ menu });
        if (search) params.set("q", auditLogMenuSearch(search));
        if (project) params.set("project", project);
        load(`${organizationAuditLogFilterOptionsPath(organization)}?${params}`);
      },
      search ? SEARCH_DELAY_MS : 0
    );
    return () => clearTimeout(timer);
  }, [open, search, project, menu, organization, load]);

  const fetched: AuditLogMenuItem[] = fetcher.data?.items ?? [];
  const picked =
    value && !fetched.some((item) => item.value === value)
      ? [{ value, label: selectedLabel ?? missingLabel, environment: selectedEnvironment }]
      : [];
  const items: AuditLogMenuItem[] = search
    ? fetched
    : [{ value: ANY, label: anyLabel }, ...picked, ...fetched];
  const loading = fetcher.state !== "idle";
  const pickedItem = fetched.find((item) => item.value === value);
  const selectedText = chipText(
    label,
    !value ? undefined : selectedLabel ? (
      <MenuLabel label={selectedLabel} environment={selectedEnvironment} />
    ) : pickedItem ? (
      <MenuLabel label={pickedItem.label} environment={pickedItem.environment} />
    ) : (
      missingLabel
    )
  );

  return (
    <FilterChip
      isSet={Boolean(value)}
      onClear={() => onChange(undefined)}
      clearLabel={`Clear ${label.toLowerCase()} filter`}
    >
      <Select
        value={value ?? ANY}
        setValue={(next) => onChange(next === ANY ? undefined : next)}
        open={open}
        setOpen={setOpen}
        items={items}
        // The server already searched: show what it found.
        filter={() => true}
        onSearchChange={setSearch}
        clearSearchOnSelection
        text={selectedText}
        heading={heading}
        shortcut={shortcut}
        tooltipTitle={`Filter by ${label.toLowerCase()}`}
        dropdownIcon={!value}
        variant={value ? "minimal/small" : "secondary/small"}
        className={value ? CHIP_TRIGGER_CLASS : undefined}
      >
        {(matches) => (
          <>
            {matches.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-baseline gap-2">
                  <MenuLabel label={item.label} environment={item.environment} />
                  {item.detail ? (
                    <span className="text-xs text-text-dimmed">{item.detail}</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
            {loading && fetched.length === 0 ? <SelectItem disabled>Loading…</SelectItem> : null}
            {!loading && search && fetched.length === 0 ? (
              <SelectItem disabled>No matches</SelectItem>
            ) : null}
            {fetcher.data?.more ? (
              <SelectItem disabled>
                {search ? "Keep typing to narrow" : "Type to search more"}
              </SelectItem>
            ) : null}
          </>
        )}
      </Select>
    </FilterChip>
  );
}
