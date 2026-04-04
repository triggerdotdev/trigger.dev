import * as Ariakit from "@ariakit/react";
import { FingerPrintIcon, TagIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import { WaitpointTokenStatus, waitpointTokenStatuses } from "@trigger.dev/core/v3";
import { ListChecks } from "lucide-react";
import { matchSorter } from "match-sorter";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { type loader as tagsLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tags";
import {
  IdFilterDropdown,
  type IdFilterDropdownProps,
  appliedSummary,
  FilterMenuProvider,
  TimeFilter,
} from "./SharedFilters";
import { WaitpointStatusCombo, waitpointStatusTitle } from "./WaitpointStatus";

export const WaitpointSearchParamsSchema = z.object({
  id: z.string().optional(),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    WaitpointTokenStatus.array().optional()
  ),
  idempotencyKey: z.string().optional(),
  tags: z.string().array().optional(),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
});
export type WaitpointSearchParams = z.infer<typeof WaitpointSearchParamsSchema>;

type WaitpointTokenFiltersProps = {
  hasFilters: boolean;
};

export function WaitpointTokenFilters(props: WaitpointTokenFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("tags") ||
    searchParams.has("id") ||
    searchParams.has("idempotencyKey");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <PermanentStatusFilter />
      <PermanentTagsFilter />
      <PermanentWaitpointIdFilter />
      <PermanentIdempotencyKeyFilter />
      <TimeFilter shortcut={{ key: "d" }} />
      {hasFilters && (
        <Form className="h-6">
          <Button variant="minimal/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
        </Form>
      )}
    </div>
  );
}

const statuses = waitpointTokenStatuses.map((status) => ({
  title: waitpointStatusTitle(status),
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
                      <WaitpointStatusCombo status={item.value} iconClassName="animate-none" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={50}>
                      <Paragraph variant="extra-small">
                        {waitpointStatusTitle(item.value)}
                      </Paragraph>
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

const statusShortcut = { key: "s" };

function PermanentStatusFilter() {
  const { values, del } = useSearchParams();
  const selectedStatuses = values("statuses");
  const hasStatuses = selectedStatuses.length > 0 && !selectedStatuses.every((v) => v === "");
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
            <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
              <Ariakit.TooltipAnchor
                render={
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasStatuses ? (
                  <AppliedFilter
                    label="Status"
                    icon={<StatusIcon className="size-3.5" />}
                    value={appliedSummary(
                      selectedStatuses.map((v) =>
                        waitpointStatusTitle(v as WaitpointTokenStatus)
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
      searchParams.set("name", searchValue);
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
        {!(filtered.length === 0 && fetcher.state !== "loading") && (
          <ComboBox
            value={searchValue}
            render={(props) => (
              <div className="flex items-center justify-stretch">
                <input {...props} placeholder={"Filter by tags..."} />
                {fetcher.state === "loading" && <Spinner color="muted" />}
              </div>
            )}
          />
        )}
        <SelectList>
          {filtered.length > 0
            ? filtered.map((tag) => (
                <SelectItem key={tag} value={tag} className="text-text-bright">
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

const tagsShortcut = { key: "g" };

function PermanentTagsFilter() {
  const { values, del } = useSearchParams();
  const tags = values("tags");
  const hasTags = tags.length > 0 && !tags.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: tagsShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TagsDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
              <Ariakit.TooltipAnchor
                render={
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasTags ? (
                  <AppliedFilter
                    label="Tags"
                    icon={<TagIcon className="size-3.5" />}
                    value={appliedSummary(tags)}
                    onRemove={() => del(["tags", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <TagIcon className="size-4" />
                    <span>Tags</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by tags</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={tagsShortcut}
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

function WaitpointIdDropdown(props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">) {
  return (
    <IdFilterDropdown
      {...props}
      label="Waitpoint ID"
      placeholder="waitpoint_"
      paramKey="id"
      validate={(v) => {
        if (!v.startsWith("waitpoint_")) return "Waitpoint IDs start with 'waitpoint_'";
        if (v.length !== 35) return "Waitpoint IDs are 35 characters long";
        return undefined;
      }}
    />
  );
}

const waitpointIdShortcut = { key: "w" };

function PermanentWaitpointIdFilter() {
  const { value, del } = useSearchParams();
  const id = value("id");
  const hasId = id !== undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: waitpointIdShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <WaitpointIdDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
              <Ariakit.TooltipAnchor
                render={
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasId ? (
                  <AppliedFilter
                    label="ID"
                    icon={<FingerPrintIcon className="size-3.5" />}
                    value={id}
                    onRemove={() => del(["id", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <FingerPrintIcon className="size-4" />
                    <span>Waitpoint ID</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by waitpoint ID</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={waitpointIdShortcut}
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

function IdempotencyKeyDropdown(props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey" | "validate">) {
  return (
    <IdFilterDropdown
      {...props}
      label="Idempotency key"
      placeholder=""
      paramKey="idempotencyKey"
      validate={(v) => {
        if (v.length === 0) return "Idempotency keys need to be at least 1 character in length";
        return undefined;
      }}
    />
  );
}

const idempotencyKeyShortcut = { key: "i" };

function PermanentIdempotencyKeyFilter() {
  const { value, del } = useSearchParams();
  const idempotencyKey = value("idempotencyKey");
  const hasKey = idempotencyKey !== undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: idempotencyKeyShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <IdempotencyKeyDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
              <Ariakit.TooltipAnchor
                render={
                  <Ariakit.Select
                    ref={triggerRef as any}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {hasKey ? (
                  <AppliedFilter
                    label="Idempotency key"
                    icon={<ListChecks className="size-3.5" />}
                    value={idempotencyKey}
                    onRemove={() => del(["idempotencyKey", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <ListChecks className="size-4" />
                    <span>Idempotency key</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by idempotency key</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={idempotencyKeyShortcut}
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
