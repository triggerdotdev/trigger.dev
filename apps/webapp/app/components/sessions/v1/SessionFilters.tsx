import * as Ariakit from "@ariakit/react";
import {
  CpuChipIcon,
  FingerPrintIcon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { ListFilterIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  SelectButtonItem,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { Button } from "../../primitives/Buttons";
import {
  appliedSummary,
  FilterMenuProvider,
  TimeFilter,
} from "../../runs/v3/SharedFilters";
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

type SessionFiltersProps = {
  hasFilters: boolean;
  possibleTypes?: string[];
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
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <TimeFilter />
      <AppliedFilters />
      {hasFilters && (
        <Form className="h-6">
          <Button variant="secondary/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  {
    name: "statuses",
    title: "Status",
    icon: <StatusIcon className="size-4 border-text-bright" />,
  },
  { name: "types", title: "Type", icon: <CpuChipIcon className="size-4" /> },
  {
    name: "taskIdentifiers",
    title: "Task",
    icon: <TaskIcon className="size-4" />,
  },
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
          <ListFilterIcon className="size-3.5" />
        </div>
      }
      variant={"secondary/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter sessions"}
    >
      Filter
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
      <AppliedStatusFilter />
      <AppliedTypeFilter />
      <AppliedTaskIdentifierFilter />
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
    case "statuses":
      return <StatusDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "types":
      return <TypeDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "taskIdentifiers":
      return (
        <TaskIdentifierDropdown onClose={() => props.setFilterType(undefined)} {...props} />
      );
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
              {type.title}
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
                    <SessionStatusCombo status={item.value} iconClassName="animate-none" />
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

function AppliedStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");

  if (statuses.length === 0) return null;

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                icon={<StatusIcon className="size-3.5" />}
                value={appliedSummary(
                  statuses.map((v) => sessionStatusTitle(v as (typeof allSessionStatuses)[number]))
                )}
                onRemove={() => del(["statuses", "cursor", "direction"])}
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
                icon={<CpuChipIcon className="size-3.5" />}
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
}: {
  trigger: ReactNode;
  searchValue: string;
  clearSearchValue: () => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const current = value("taskIdentifiers");
  const [draft, setDraft] = useState(current ?? "");

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      taskIdentifiers: draft.trim() === "" ? undefined : [draft.trim()],
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
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Task identifier</Label>
            <Input
              placeholder="my-task"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
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

function AppliedTaskIdentifierFilter() {
  const { values, del } = useSearchParams();
  const taskIdentifiers = values("taskIdentifiers");
  if (taskIdentifiers.length === 0) return null;

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TaskIdentifierDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Task"
                icon={<TaskIcon className="size-3.5" />}
                value={appliedSummary(taskIdentifiers)}
                onRemove={() => del(["taskIdentifiers", "cursor", "direction"])}
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

function ExternalIdDropdown({
  trigger,
  searchValue,
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
                icon={<FingerPrintIcon className="size-3.5" />}
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
  searchValue,
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
                icon={<TagIcon className="size-3.5" />}
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

