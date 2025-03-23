import * as Ariakit from "@ariakit/react";
import { CalendarIcon, FingerPrintIcon, TagIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import { TaskTriggerSource } from "@trigger.dev/database";
import { ListChecks, ListFilterIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { Button } from "~/components/primitives/Buttons";
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
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import {
  AppliedCustomDateRangeFilter,
  AppliedPeriodFilter,
  appliedSummary,
  CreatedAtDropdown,
  CustomDateRangeDropdown,
  FilterMenuProvider,
} from "./SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { WaitpointStatusCombo, waitpointStatusTitle } from "./WaitpointStatus";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { useEnvironment } from "~/hooks/useEnvironment";
import { matchSorter } from "match-sorter";
import { Spinner } from "~/components/primitives/Spinner";
import { project } from "effect/Layer";
import { useProject } from "~/hooks/useProject";
import { type loader as tagsLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tags";
import { useOrganization } from "~/hooks/useOrganizations";
import { Label } from "~/components/primitives/Label";
import { Input } from "~/components/primitives/Input";
import { FormError } from "~/components/primitives/FormError";

const filterableStatuses = ["PENDING", "COMPLETED", "FAILED"] as const;
export const WaitpointFilterStatus = z.enum(filterableStatuses);
export type WaitpointFilterStatus = z.infer<typeof WaitpointFilterStatus>;

export const WaitpointSearchParamsSchema = z.object({
  friendlyId: z.string().optional(),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    WaitpointFilterStatus.array().optional()
  ),
  idempotencyKey: z.string().optional(),
  tags: z.string().array().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
});

type WaitpointTokenFiltersProps = {
  hasFilters: boolean;
};

export function WaitpointTokenFilters(props: WaitpointTokenFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("period") ||
    searchParams.has("tags") ||
    searchParams.has("from") ||
    searchParams.has("to") ||
    searchParams.has("id") ||
    searchParams.has("idempotencyKey");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu />
      <AppliedFilters />
      {hasFilters && (
        <Form className="h-6">
          <Button variant="minimal/small" LeadingIcon={TrashIcon}>
            Clear all
          </Button>
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  {
    name: "statuses",
    title: "Status",
    icon: <StatusIcon className="size-4" />,
  },
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
  { name: "created", title: "Created", icon: <CalendarIcon className="size-4" /> },
  { name: "daterange", title: "Custom date range", icon: <CalendarIcon className="size-4" /> },
  { name: "id", title: "Waitpoint ID", icon: <FingerPrintIcon className="size-4" /> },
  { name: "idempotencyKey", title: "Idempotency key", icon: <ListChecks className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu() {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <ListFilterIcon className="size-3.5" />
        </div>
      }
      variant={"minimal/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter runs"}
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
        />
      )}
    </FilterMenuProvider>
  );
}

function AppliedFilters() {
  return (
    <>
      <AppliedStatusFilter />
      <AppliedTagsFilter />
      <AppliedPeriodFilter />
      <AppliedCustomDateRangeFilter />
      <AppliedWaitpointIdFilter />
      <AppliedIdempotencyKeyFilter />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: React.ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
};

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "statuses":
      return <StatusDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "created":
      return <CreatedAtDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "daterange":
      return <CustomDateRangeDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "id":
      return <WaitpointIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "idempotencyKey":
      return <IdempotencyKeyDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) => {
      if (item.name === "daterange") return false;
      return item.title.toLowerCase().includes(searchValue.toLowerCase());
    });
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

const statuses = filterableStatuses.map((status) => ({
  title: statusTitle(status),
  value: status,
}));

function statusTitle(status: WaitpointFilterStatus) {
  switch (status) {
    case "COMPLETED": {
      return "Completed";
    }
    case "FAILED": {
      return "Timed out";
    }
    case "PENDING": {
      return "Waiting";
    }
  }
}

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

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ statuses: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
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
          {filtered.map((item, index) => {
            return (
              <SelectItem
                key={item.value}
                value={item.value}
                shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
              >
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="group flex w-full flex-col py-0">
                      <WaitpointStatusCombo
                        status={item.value === "FAILED" ? "COMPLETED" : item.value}
                        outputIsError={item.value === "FAILED"}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={50}>
                      <Paragraph variant="extra-small">{statusTitle(item.value)}</Paragraph>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </SelectItem>
            );
          })}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");

  if (statuses.length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                value={appliedSummary(statuses.map((v) => statusTitle(v as WaitpointFilterStatus)))}
                onRemove={() => del(["statuses", "cursor", "direction"])}
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
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      tags: values,
      cursor: undefined,
      direction: undefined,
    });
  };

  const fetcher = useFetcher<typeof tagsLoader>();

  useEffect(() => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("name", encodeURIComponent(searchValue));
    }
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/waitpoints/tags?${searchParams}`
    );
  }, [searchValue]);

  const filtered = useMemo(() => {
    let items: string[] = [];
    if (searchValue === "") {
      items = values("tags");
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.tags.map((t) => t.name));

    return matchSorter(Array.from(new Set(items)), searchValue);
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={values("tags")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by tags..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((tag, index) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No tags found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTagsFilter() {
  const { values, del } = useSearchParams();

  const tags = values("tags");

  if (tags.length === 0) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TagsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Tags"
                value={appliedSummary(values("tags"))}
                onRemove={() => del(["tags", "cursor", "direction"])}
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

function WaitpointIdDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const idValue = value("friendlyId");

  const [friendlyId, setFriendlyId] = useState(idValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      friendlyId: friendlyId === "" ? undefined : friendlyId?.toString(),
    });

    setOpen(false);
  }, [friendlyId, replace]);

  let error: string | undefined = undefined;
  if (friendlyId) {
    if (!friendlyId.startsWith("waitpooint_")) {
      error = "Waitpoint IDs start with 'waitpoint_'";
    } else if (friendlyId.length !== 35) {
      error = "Waitpoint IDs are 35 characters long";
    }
  }

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
            <Label>Waitpoint ID</Label>
            <Input
              placeholder="run_"
              value={friendlyId ?? ""}
              onChange={(e) => setFriendlyId(e.target.value)}
              variant="small"
              className="w-[27ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !friendlyId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedWaitpointIdFilter() {
  const { value, del } = useSearchParams();

  if (value("friendlyId") === undefined) {
    return null;
  }

  const friendlyId = value("friendlyId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <WaitpointIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Waitpoint ID"
                value={friendlyId}
                onRemove={() => del(["friendlyId", "cursor", "direction"])}
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

function IdempotencyKeyDropdown({
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
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const idValue = value("idempotencyKey");

  const [idempotencyKey, setIdempotencyKey] = useState(idValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      idempotencyKey: idempotencyKey === "" ? undefined : idempotencyKey?.toString(),
    });

    setOpen(false);
  }, [idempotencyKey, replace]);

  let error: string | undefined = undefined;
  if (idempotencyKey) {
    if (idempotencyKey.length === 0) {
      error = "Idempotency keys need to be at least 1 character in length";
    }
  }

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
            <Label>Idempotency key</Label>
            <Input
              placeholder="run_"
              value={idempotencyKey ?? ""}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              variant="small"
              className="w-[27ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !idempotencyKey}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedIdempotencyKeyFilter() {
  const { value, del } = useSearchParams();

  if (value("idempotencyKey") === undefined) {
    return null;
  }

  const idempotencyKey = value("idempotencyKey");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <WaitpointIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Idempotency key"
                value={idempotencyKey}
                onRemove={() => del(["idempotencyKey", "cursor", "direction"])}
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
