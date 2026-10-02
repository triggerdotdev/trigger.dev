import * as Ariakit from "@ariakit/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { type ReactNode, useMemo, useRef } from "react";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { SearchInput } from "~/components/primitives/SearchInput";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
} from "~/components/primitives/Select";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { appliedSummary, FilterMenuProvider } from "~/components/runs/v3/SharedFilters";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";

const STATUS_OPTIONS = [
  { value: "active", title: "Active" },
  { value: "inactive", title: "Inactive" },
  { value: "disabled", title: "Disabled" },
];

/** Subscriber, source and status filters plus a tenant / external ref search for the endpoints list. */
export function EndpointFilters({
  subscribers,
  sources,
}: {
  subscribers: string[];
  sources: string[];
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters = ["subscribers", "sources", "statuses", "search"].some((key) =>
    searchParams.has(key)
  );

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <MultiSelectFilter
        param="statuses"
        label="Status"
        placeholderLabel="Active"
        icon={<StatusIcon className="size-4 border-text-bright" />}
        options={STATUS_OPTIONS}
        shortcut={{ key: "s" }}
      />
      <MultiSelectFilter
        param="subscribers"
        label="Subscriber"
        icon={<WebhookIcon className="size-4 text-webhooks" />}
        options={subscribers.map((value) => ({ value, title: value }))}
        shortcut={{ key: "u" }}
        searchable
      />
      <MultiSelectFilter
        param="sources"
        label="Source"
        icon={<WebhookIcon className="size-4 text-text-dimmed" />}
        options={sources.map((value) => ({ value, title: value }))}
        shortcut={{ key: "o" }}
      />
      <div className="w-56">
        <SearchInput placeholder="Search tenant or external ref…" />
      </div>
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

function MultiSelectFilter({
  param,
  label,
  placeholderLabel,
  icon,
  options,
  shortcut,
  searchable = false,
}: {
  param: string;
  label: string;
  placeholderLabel?: string;
  icon: ReactNode;
  options: Array<{ value: string; title: string }>;
  shortcut: ShortcutDefinition;
  searchable?: boolean;
}) {
  const { values, replace, del } = useSearchParams();
  const selected = values(param).filter((value) => value !== "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option.title])),
    [options]
  );

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
      {(search, setSearch) => {
        const visible = searchable
          ? options.filter((option) => option.title.toLowerCase().includes(search.toLowerCase()))
          : options;
        return (
          <SelectProvider
            value={selected}
            setValue={(next: string[]) => {
              setSearch("");
              replace({
                [param]: next.length > 0 ? next : undefined,
                cursor: undefined,
                direction: undefined,
              });
            }}
            virtualFocus={true}
          >
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
                {selected.length > 0 ? (
                  <AppliedFilter
                    label={label}
                    icon={icon}
                    value={appliedSummary(
                      selected.map((value) => titleByValue.get(value) ?? value)
                    )}
                    onRemove={() => del([param, "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    {icon}
                    <span>{placeholderLabel ? `${label}: ${placeholderLabel}` : label}</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by {label.toLowerCase()}</span>
                  <ShortcutKey className="size-4 flex-none" shortcut={shortcut} variant="small" />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
            <SelectPopover className="min-w-0 max-w-[min(360px,var(--popover-available-width))]">
              {searchable ? (
                <ComboBox placeholder={`Filter by ${label.toLowerCase()}...`} value={search} />
              ) : null}
              <SelectList>
                {visible.length > 0 ? (
                  visible.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      className="text-text-bright"
                    >
                      {option.title}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem disabled>Nothing to filter by</SelectItem>
                )}
              </SelectList>
            </SelectPopover>
          </SelectProvider>
        );
      }}
    </FilterMenuProvider>
  );
}
