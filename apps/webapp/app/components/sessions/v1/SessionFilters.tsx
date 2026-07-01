import * as Ariakit from "@ariakit/react";
import {
  CpuChipIcon,
  FingerPrintIcon,
  PlusIcon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import {
  ComboBox,
  SelectButtonItem,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Button } from "../../primitives/Buttons";
import { appliedSummary, FilterMenuProvider, TimeFilter } from "../../runs/v3/SharedFilters";
import {
  allSessionStatuses,
  descriptionForSessionStatus,
  SessionStatusCombo,
  sessionStatusTitle,
} from "./SessionStatus";

const StringOrStringArray = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string()).optional()
);

export const SessionStatus = z.enum(allSessionStatuses);

export const SessionListSearchFilters = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    SessionStatus.array().optional()
  ),
  types: StringOrStringArray,
  taskIdentifiers: StringOrStringArray,
  externalId: z.string().optional(),
  tags: StringOrStringArray,
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export type SessionListSearchFilters = z.infer<typeof SessionListSearchFilters>;
export type SessionListSearchFilterKey = keyof SessionListSearchFilters;

export function getSessionFiltersFromSearchParams(
  searchParams: URLSearchParams
): SessionListSearchFilters {
  function listOrUndefined(key: string) {
    const values = searchParams.getAll(key).filter((v) => v.length > 0);
    return values.length > 0 ? values : undefined;
  }

  const params = {
    cursor: searchParams.get("cursor") ?? undefined,
    direction: searchParams.get("direction") ?? undefined,
    statuses: listOrUndefined("statuses"),
    types: listOrUndefined("types"),
    taskIdentifiers: listOrUndefined("taskIdentifiers"),
    externalId: searchParams.get("externalId") ?? undefined,
    tags: listOrUndefined("tags"),
    period: searchParams.get("period") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };

  const parsed = SessionListSearchFilters.safeParse(params);
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
}

type PossibleTask = { slug: string; isInLatestDeployment: boolean };

type SessionFiltersProps = {
  hasFilters: boolean;
  possibleTypes?: string[];
  possibleTasks: PossibleTask[];
};

export function SessionFilters(props: SessionFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("types") ||
    searchParams.has("taskIdentifiers") ||
    searchParams.has("externalId") ||
    searchParams.has("tags");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <PermanentStatusFilter />
      <PermanentTaskIdentifierFilter possibleTasks={props.possibleTasks} />
      <TimeFilter shortcut={{ key: "d" }} />
      <AppliedFilters />
      <FilterMenu {...props} />
      {hasFilters && (
        <Form className="-ml-1 h-6">
          <Button
            variant="minimal/small"
            LeadingIcon={XMarkIcon}
            tooltip="Clear all filters"
            className="group-hover/button:bg-transparent"
            leadingIconClassName="group-hover/button:text-text-bright"
          />
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  { name: "types", title: "Type", icon: <CpuChipIcon className="size-4" /> },
  {
    name: "externalId",
    title: "External ID",
    icon: <FingerPrintIcon className="size-4" />,
  },
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: SessionFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <PlusIcon className="size-3.5" />
        </div>
      }
      variant={"secondary/small"}
      shortcut={shortcut}
      tooltipTitle={"More filters"}
      className="pl-1 pr-2"
    >
      More filters
    </SelectTrigger>
  );

  return (
    <FilterMenuProvider onClose={() => setFilterType(undefined)}>
      {(search, setSearch) => (
        <Menu
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          trigger={filterTrigger}
          filterType={filterType}
          setFilterType={setFilterType}
          {...props}
        />
      )}
    </FilterMenuProvider>
  );
}

function AppliedFilters() {
  return (
    <>
      <AppliedTypeFilter />
      <AppliedExternalIdFilter />
      <AppliedTagsFilter />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: React.ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
} & SessionFiltersProps;

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "types":
      return <TypeDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "externalId":
      return <ExternalIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) =>
      item.title.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter by..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((type, index) => (
            <SelectButtonItem
              key={type.name}
              onClick={() => {
                clearSearchValue();
                setFilterType(type.name);
              }}
              icon={type.icon}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span className="text-text-bright">{type.title}</span>
            </SelectButtonItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statusItems = allSessionStatuses.map((status) => ({
  title: sessionStatusTitle(status),
  value: status,
}));

function StatusDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (next: string[]) => {
    clearSearchValue();
    replace({ statuses: next, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return statusItems.filter((item) =>
      item.title.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider value={values("statuses")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
      >
        <ComboBox placeholder={"Filter by status..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger className="group flex w-full flex-col py-0">
                    <SessionStatusCombo status={item.value} />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={9}>
                    <Paragraph variant="extra-small">
                      {descriptionForSessionStatus(item.value)}
                    </Paragraph>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statusShortcut = { key: "s" };

function PermanentStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");
  const hasStatuses = statuses.length > 0 && !statuses.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: statusShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasStatuses ? (
                  <AppliedFilter
                    label="Status"
                    icon={<StatusIcon className="size-4 border-text-bright" />}
                    value={appliedSummary(
                      statuses.map((v) =>
                        sessionStatusTitle(v as (typeof allSessionStatuses)[number])
                      )
                    )}
                    onRemove={() => del(["statuses", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <div className="grid size-4 place-items-center">
                      <div className="size-[75%] rounded-full border-2 border-text-bright" />
                    </div>
                    <span>Status</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by status</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={statusShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function TypeDropdown({
  trigger,
  searchValue,
  clearSearchValue,
  possibleTypes,
  onClose,
}: {
  trigger: ReactNode;
  searchValue: string;
  clearSearchValue: () => void;
  possibleTypes?: string[];
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (next: string[]) => {
    clearSearchValue();
    replace({ types: next, cursor: undefined, direction: undefined });
  };

  const items = useMemo(() => {
    const all = possibleTypes && possibleTypes.length > 0 ? possibleTypes : ["chat"];
    const seen = new Set(all);
    for (const v of values("types")) {
      if (!seen.has(v)) {
        all.push(v);
        seen.add(v);
      }
    }
    return all.filter((t) => t.toLowerCase().includes(searchValue.toLowerCase()));
  }, [possibleTypes, searchValue, values]);

  return (
    <SelectProvider value={values("types")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
      >
        <ComboBox placeholder={"Filter by type..."} value={searchValue} />
        <SelectList>
          {items.map((value, index) => (
            <SelectItem
              key={value}
              value={value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span className="font-mono text-xs">{value}</span>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTypeFilter() {
  const { values, del } = useSearchParams();
  const types = values("types");
  if (types.length === 0) return null;

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TypeDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Type"
                icon={<CpuChipIcon className="size-4" />}
                value={appliedSummary(types)}
                onRemove={() => del(["types", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function TaskIdentifierDropdown({
  trigger,
  searchValue,
  clearSearchValue,
  onClose,
  possibleTasks,
}: {
  trigger: ReactNode;
  searchValue: string;
  clearSearchValue: () => void;
  onClose?: () => void;
  possibleTasks: PossibleTask[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (newValues: string[]) => {
    clearSearchValue();
    replace({
      taskIdentifiers: newValues.length > 0 ? newValues : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const selected = values("taskIdentifiers");

  const filtered = useMemo(() => {
    // Surface any selected identifiers that aren't in the registry (deleted
    // agents) so the dropdown can still show + un-check them.
    const seen = new Set(possibleTasks.map((t) => t.slug));
    const extras: PossibleTask[] = selected
      .filter((slug) => slug && !seen.has(slug))
      .map((slug) => ({ slug, isInLatestDeployment: false }));
    return [...possibleTasks, ...extras].filter((task) =>
      task.slug.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [possibleTasks, searchValue, selected]);

  return (
    <SelectProvider value={selected} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(360px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
      >
        <ComboBox placeholder={"Filter by Agent ID..."} value={searchValue} />
        <SelectList>
          {filtered
            .filter((item) => item.isInLatestDeployment)
            .map((item) => (
              <SelectItem
                key={item.slug}
                value={item.slug}
                icon={<CubeSparkleIcon className="size-4 flex-none text-agents" />}
                className="text-text-bright"
              >
                <MiddleTruncate text={item.slug} />
              </SelectItem>
            ))}
          {filtered.some((item) => !item.isInLatestDeployment) && (
            <SelectGroup>
              <SelectGroupLabel>Archived</SelectGroupLabel>
              {filtered
                .filter((item) => !item.isInLatestDeployment)
                .map((item) => (
                  <SelectItem
                    key={item.slug}
                    value={item.slug}
                    icon={
                      <span className="opacity-50">
                        <CubeSparkleIcon className="size-4 flex-none text-agents" />
                      </span>
                    }
                    className="text-text-bright"
                  >
                    <MiddleTruncate text={item.slug} />
                  </SelectItem>
                ))}
            </SelectGroup>
          )}
          {filtered.length === 0 && <SelectItem disabled>No agents found</SelectItem>}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const taskShortcut = { key: "t" };

function PermanentTaskIdentifierFilter({ possibleTasks }: { possibleTasks: PossibleTask[] }) {
  const { values, del } = useSearchParams();
  const taskIdentifiers = values("taskIdentifiers");
  const hasTasks = taskIdentifiers.length > 0 && !taskIdentifiers.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: taskShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TaskIdentifierDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasTasks ? (
                  <AppliedFilter
                    label="Agent ID"
                    icon={<CubeSparkleIcon className="size-4 text-text-bright" />}
                    value={appliedSummary(taskIdentifiers)}
                    onRemove={() => del(["taskIdentifiers", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <CubeSparkleIcon className="size-4 text-text-bright" />
                    <span>Agent ID</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by Agent ID</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={taskShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleTasks={possibleTasks}
        />
      )}
    </FilterMenuProvider>
  );
}

function ExternalIdDropdown({
  trigger,
  searchValue: _searchValue,
  clearSearchValue,
  onClose,
}: {
  trigger: ReactNode;
  searchValue: string;
  clearSearchValue: () => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const current = value("externalId");
  const [draft, setDraft] = useState(current ?? "");

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      externalId: draft.trim() === "" ? undefined : draft.trim(),
      cursor: undefined,
      direction: undefined,
    });
    setOpen(false);
  }, [clearSearchValue, draft, replace]);

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
        className="max-w-[min(36ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>External ID</Label>
            <Input
              placeholder="user-supplied id"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              variant="small"
              className="w-[33ch] font-mono"
              spellCheck={false}
            />
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={apply}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedExternalIdFilter() {
  const { value, del } = useSearchParams();
  const externalId = value("externalId");
  if (!externalId) return null;

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ExternalIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="External ID"
                icon={<FingerPrintIcon className="size-4" />}
                value={externalId}
                onRemove={() => del(["externalId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function TagsDropdown({
  trigger,
  searchValue: _searchValue,
  clearSearchValue,
  onClose,
}: {
  trigger: ReactNode;
  searchValue: string;
  clearSearchValue: () => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { values, replace } = useSearchParams();
  const current = values("tags");
  const [draft, setDraft] = useState(current.join(", "));

  const apply = useCallback(() => {
    clearSearchValue();
    const next = draft
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    replace({
      tags: next.length === 0 ? undefined : next,
      cursor: undefined,
      direction: undefined,
    });
    setOpen(false);
  }, [clearSearchValue, draft, replace]);

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }
          return true;
        }}
        className="max-w-[min(40ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Tags</Label>
            <Input
              placeholder="tag1, tag2"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              variant="small"
              className="w-[37ch] font-mono"
              spellCheck={false}
            />
            <Paragraph variant="extra-small/dimmed">
              Comma-separated. Matches sessions with any of these tags.
            </Paragraph>
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="secondary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={apply}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTagsFilter() {
  const { values, del } = useSearchParams();
  const tags = values("tags");
  if (tags.length === 0) return null;

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TagsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Tags"
                icon={<TagIcon className="size-4" />}
                value={appliedSummary(tags)}
                onRemove={() => del(["tags", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}
