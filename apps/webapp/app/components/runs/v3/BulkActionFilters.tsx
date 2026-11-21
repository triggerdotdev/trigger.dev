import * as Ariakit from "@ariakit/react";
import { ArrowPathIcon, UserIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { type ReactNode, useRef } from "react";
import { z } from "zod";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Button } from "../../primitives/Buttons";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "./BulkAction";
import { appliedSummary, FilterMenuProvider } from "./SharedFilters";

const multi = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => (typeof value === "string" ? [value] : value), item.array().optional());

export const BulkActionListFilters = z.object({
  types: multi(z.enum(["CANCEL", "REPLAY"])),
  statuses: multi(z.enum(["PENDING", "COMPLETED", "ABORTED"])),
  users: multi(z.string()),
});

export type BulkActionListFilters = z.infer<typeof BulkActionListFilters>;

type Option = { value: string; title: string; render: ReactNode };

const typeOptions: Option[] = [
  { value: "REPLAY", title: "Replay", render: <BulkActionTypeCombo type="REPLAY" /> },
  { value: "CANCEL", title: "Cancel", render: <BulkActionTypeCombo type="CANCEL" /> },
];

const statusOptions: Option[] = [
  { value: "PENDING", title: "In progress", render: <BulkActionStatusCombo status="PENDING" /> },
  { value: "COMPLETED", title: "Completed", render: <BulkActionStatusCombo status="COMPLETED" /> },
  { value: "ABORTED", title: "Aborted", render: <BulkActionStatusCombo status="ABORTED" /> },
];

export function BulkActionFilters({
  users,
}: {
  users: { id: string; name: string; email: string }[];
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("types") || searchParams.has("statuses") || searchParams.has("users");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <PermanentSelectFilter
        paramKey="types"
        label="Type"
        icon={<ArrowPathIcon className="size-3.5" />}
        options={typeOptions}
        shortcut={{ key: "t" }}
      />
      <PermanentSelectFilter
        paramKey="statuses"
        label="Status"
        icon={<StatusIcon className="size-3.5" />}
        options={statusOptions}
        shortcut={{ key: "s" }}
      />
      <PermanentSelectFilter
        paramKey="users"
        label="User"
        icon={<UserIcon className="size-3.5" />}
        options={users.map((user) => ({
          value: user.id,
          title: user.name,
          // Two people can share a name, so show the email too.
          render: (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{user.name}</span>
              <span className="truncate text-text-dimmed">{user.email}</span>
            </span>
          ),
        }))}
        shortcut={{ key: "u" }}
      />
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

function PermanentSelectFilter({
  paramKey,
  label,
  icon,
  options,
  shortcut,
}: {
  paramKey: string;
  label: string;
  icon: ReactNode;
  options: Option[];
  shortcut: { key: string };
}) {
  const { values, replace, del } = useSearchParams();
  const selected = values(paramKey);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(_search, setSearch) => (
        <SelectProvider
          value={selected}
          setValue={(next: string[]) => {
            setSearch("");
            replace({ [paramKey]: next, page: undefined });
          }}
          virtualFocus={true}
        >
          <Ariakit.TooltipProvider timeout={200}>
            <Ariakit.TooltipAnchor
              render={
                <Ariakit.Select
                  ref={triggerRef}
                  render={<div className="group cursor-pointer focus-custom" />}
                />
              }
            >
              {selected.length > 0 ? (
                <AppliedFilter
                  label={label}
                  icon={icon}
                  value={appliedSummary(
                    selected.map((v) => options.find((o) => o.value === v)?.title ?? v)
                  )}
                  onRemove={() => del([paramKey, "page"])}
                  variant="secondary/small"
                  className="pl-1"
                />
              ) : (
                <div className="flex h-6 items-center gap-1.5 rounded border border-border-bright bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-border-brighter group-hover:bg-surface-control">
                  {icon}
                  <span>{label}</span>
                </div>
              )}
            </Ariakit.TooltipAnchor>
            <Ariakit.Tooltip className="z-40 cursor-default rounded border border-grid-bright bg-background-bright px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span>Filter by {label.toLowerCase()}</span>
                <ShortcutKey className="size-4 flex-none" shortcut={shortcut} variant="small" />
              </div>
            </Ariakit.Tooltip>
          </Ariakit.TooltipProvider>
          <SelectPopover className="min-w-0 max-w-[min(320px,var(--popover-available-width))]">
            <SelectList>
              {options.map((option, index) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
                >
                  {option.render}
                </SelectItem>
              ))}
            </SelectList>
          </SelectPopover>
        </SelectProvider>
      )}
    </FilterMenuProvider>
  );
}
