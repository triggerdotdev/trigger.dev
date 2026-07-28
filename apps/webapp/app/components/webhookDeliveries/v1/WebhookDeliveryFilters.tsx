import * as Ariakit from "@ariakit/react";
import { BeakerIcon, FingerPrintIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
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
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Button } from "../../primitives/Buttons";
import {
  appliedSummary,
  FilterMenuProvider,
  IdFilterDropdown,
  type IdFilterDropdownProps,
  TimeFilter,
} from "~/components/runs/v3/SharedFilters";

// Match DeliveriesTable's DELIVERY_STATUS_COLOR / DELIVERY_STATUS_LABEL.
const deliveryStatuses: { value: WebhookDeliveryStatus; title: string; color: string }[] = [
  { value: "PENDING", title: "Pending", color: "#878C99" },
  { value: "PROCESSING", title: "Processing", color: "#3B82F6" },
  { value: "SUCCEEDED", title: "Succeeded", color: "#28BF5C" },
  { value: "FAILED", title: "Failed", color: "#E11D48" },
];

const statusTitleByValue = new Map(deliveryStatuses.map((s) => [s.value, s.title]));

function StatusDot({ color }: { color: string }) {
  return <span className="size-2 rounded-full" style={{ backgroundColor: color }} />;
}

export type PossibleWebhook = { slug: string; source: string };

type WebhookDeliveryFiltersProps = {
  possibleWebhooks: PossibleWebhook[];
  /** Custom default period for the time filter (e.g., "1h", "7d") */
  defaultPeriod?: string;
};

export function WebhookDeliveryFilters(props: WebhookDeliveryFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("webhooks") ||
    searchParams.has("deliveryId") ||
    searchParams.has("runId") ||
    searchParams.has("test");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <PermanentStatusFilter />
      <PermanentWebhookFilter possibleWebhooks={props.possibleWebhooks} />
      <PermanentTestFilter />
      <TimeFilter defaultPeriod={props.defaultPeriod} shortcut={{ key: "d" }} />
      <AppliedFilters />
      <FilterMenu />
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
  { name: "deliveryId", title: "Delivery ID", icon: <FingerPrintIcon className="size-4" /> },
  { name: "runId", title: "Run ID", icon: <FingerPrintIcon className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const moreFiltersShortcut = { key: "f" };

function FilterMenu() {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <PlusIcon className="size-3.5" />
        </div>
      }
      variant={"secondary/small"}
      shortcut={moreFiltersShortcut}
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
        />
      )}
    </FilterMenuProvider>
  );
}

function AppliedFilters() {
  return (
    <>
      <AppliedDeliveryIdFilter />
      <AppliedRunIdFilter />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
};

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "deliveryId":
      return <DeliveryIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "runId":
      return <RunIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ trigger, clearSearchValue, setFilterType }: MenuProps) {
  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <SelectList>
          {filterTypes.map((type, index) => (
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

function StatusDropdown({
  trigger,
  clearSearchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ statuses: values, cursor: undefined, direction: undefined });
  };

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
          {deliveryStatuses.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span className="flex items-center gap-1.5 text-text-bright">
                <StatusDot color={item.color} />
                <span>{item.title}</span>
              </span>
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
      {(_search, setSearch) => (
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
                      statuses.map((v) => statusTitleByValue.get(v as WebhookDeliveryStatus) ?? v)
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
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function WebhookDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleWebhooks,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleWebhooks: PossibleWebhook[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (newValues: string[]) => {
    clearSearchValue();
    replace({
      webhooks: newValues.length > 0 ? newValues : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const filtered = useMemo(() => {
    return possibleWebhooks.filter((item) =>
      item.slug.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue, possibleWebhooks]);

  return (
    <SelectProvider value={values("webhooks")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder={"Filter by webhook..."} value={searchValue} />
        <SelectList>
          {filtered.length > 0 ? (
            filtered.map((item) => (
              <SelectItem
                key={item.slug}
                value={item.slug}
                icon={<WebhookIcon className="size-4 flex-none text-webhooks" />}
                className="text-text-bright"
              >
                {item.slug}
              </SelectItem>
            ))
          ) : (
            <SelectItem disabled>No webhooks found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const webhookShortcut = { key: "w" };

function PermanentWebhookFilter({ possibleWebhooks }: { possibleWebhooks: PossibleWebhook[] }) {
  const { values, del } = useSearchParams();
  const webhooks = values("webhooks");
  const hasWebhooks = webhooks.length > 0 && !webhooks.every((v) => v === "");
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: webhookShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <WebhookDropdown
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
                {hasWebhooks ? (
                  <AppliedFilter
                    label="Webhook"
                    icon={<WebhookIcon className="size-4 text-webhooks" />}
                    value={appliedSummary(webhooks)}
                    onRemove={() => del(["webhooks", "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <WebhookIcon className="size-4 text-webhooks" />
                    <span>Webhook</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by webhook</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={webhookShortcut}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleWebhooks={possibleWebhooks}
        />
      )}
    </FilterMenuProvider>
  );
}

const testModes = [
  { value: "all", title: "All deliveries" },
  { value: "hide", title: "Hide test sends" },
  { value: "only", title: "Test sends only" },
] as const;

const testShortcut = { key: "t" };

function TestDropdown({ trigger, onClose }: { trigger: ReactNode; onClose?: () => void }) {
  const { value, replace } = useSearchParams();
  const current = value("test") ?? "all";

  const handleChange = (next: string) => {
    replace({ test: next === "all" ? undefined : next, cursor: undefined, direction: undefined });
  };

  return (
    <SelectProvider value={current} setValue={handleChange} virtualFocus={true}>
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
          {testModes.map((mode, index) => (
            <SelectItem
              key={mode.value}
              value={mode.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <span className="text-text-bright">{mode.title}</span>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function PermanentTestFilter() {
  const { value, del } = useSearchParams();
  const current = value("test");
  const active = current === "hide" || current === "only";
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: testShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <TestDropdown
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
            {active ? (
              <AppliedFilter
                label="Test"
                icon={<BeakerIcon className="size-4" />}
                value={current === "only" ? "Test sends only" : "Hidden"}
                onRemove={() => del(["test", "cursor", "direction"])}
                variant="secondary/small"
                className="pl-1"
              />
            ) : (
              <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                <BeakerIcon className="size-4 text-text-bright" />
                <span>Test</span>
              </div>
            )}
          </Ariakit.TooltipAnchor>
          <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span>Filter test sends</span>
              <ShortcutKey className="size-4 flex-none" shortcut={testShortcut} variant="small" />
            </div>
          </Ariakit.Tooltip>
        </Ariakit.TooltipProvider>
      }
    />
  );
}

function DeliveryIdDropdown(
  props: Omit<IdFilterDropdownProps, "label" | "placeholder" | "paramKey">
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Delivery ID"
      placeholder="whd_ or external id"
      paramKey="deliveryId"
    />
  );
}

function AppliedDeliveryIdFilter() {
  const { value, del } = useSearchParams();

  if (value("deliveryId") === undefined) {
    return null;
  }

  const deliveryId = value("deliveryId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <DeliveryIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Delivery ID"
                icon={<FingerPrintIcon className="size-4" />}
                value={deliveryId}
                onRemove={() => del(["deliveryId", "cursor", "direction"])}
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

function validateRunId(value: string): string | undefined {
  if (!value.startsWith("run_")) return "Run IDs start with 'run_'";
  if (value.length !== 25 && value.length !== 29) return "Run IDs are 25 or 29 characters long";
}

function RunIdDropdown(
  props: Omit<
    IdFilterDropdownProps,
    "label" | "placeholder" | "paramKey" | "validate" | "inputWidth"
  >
) {
  return (
    <IdFilterDropdown
      {...props}
      label="Run ID"
      placeholder="run_"
      paramKey="runId"
      validate={validateRunId}
      inputWidth="w-[27ch]"
    />
  );
}

function AppliedRunIdFilter() {
  const { value, del } = useSearchParams();

  if (value("runId") === undefined) {
    return null;
  }

  const runId = value("runId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <RunIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Run ID"
                icon={<FingerPrintIcon className="size-4" />}
                value={runId}
                onRemove={() => del(["runId", "cursor", "direction"])}
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
