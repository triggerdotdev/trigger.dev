import * as Ariakit from "@ariakit/react";
import { BeakerIcon, FingerPrintIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useRef } from "react";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import {
  FilterMenuProvider,
  IdFilterDropdown,
  TimeFilter,
} from "~/components/runs/v3/SharedFilters";
import {
  MultiSelectFilter,
  type MultiSelectFilterOption,
} from "~/components/webhookEndpoints/v1/EndpointFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import {
  DELIVERY_FILTER_PARAMS,
  DELIVERY_STATUS_FILTERS,
  LIVE_DELIVERY_MODE,
  TEST_DELIVERY_MODE,
} from "./deliveryListFilters";
import { DELIVERY_STATUS_COLOR, DELIVERY_STATUS_LABEL } from "./DeliveryStatus";

const STATUS_OPTIONS: MultiSelectFilterOption[] = DELIVERY_STATUS_FILTERS.map((status) => ({
  value: status,
  title: DELIVERY_STATUS_LABEL[status],
  icon: (
    <span
      className="mr-1 size-2 shrink-0 rounded-full"
      style={{ backgroundColor: DELIVERY_STATUS_COLOR[status] }}
    />
  ),
}));

const MODE_OPTIONS: MultiSelectFilterOption[] = [
  { value: LIVE_DELIVERY_MODE, title: "Live" },
  { value: TEST_DELIVERY_MODE, title: "Test" },
];

const DELIVERY_ID_PARAM = "deliveryId";
const DELIVERY_ID_SHORTCUT: ShortcutDefinition = { key: "i" };

/** Everything "Clear all filters" resets: the list filters plus the time window. */
const CLEARABLE_PARAMS = [...DELIVERY_FILTER_PARAMS, "period", "from", "to"];

/** Status, mode, delivery ID and time filters for an endpoint's deliveries. */
export function DeliveryFilters() {
  const { has, del } = useSearchParams();
  const hasFilters = CLEARABLE_PARAMS.some((param) => has(param));

  return (
    <div className="flex flex-row flex-wrap items-center gap-1.5">
      <MultiSelectFilter
        param="statuses"
        label="Status"
        icon={<StatusIcon className="size-4 border-text-bright" />}
        options={STATUS_OPTIONS}
        shortcut={{ key: "s" }}
      />
      <MultiSelectFilter
        param="mode"
        label="Mode"
        icon={<BeakerIcon className="size-4 text-text-dimmed" />}
        options={MODE_OPTIONS}
        shortcut={{ key: "m" }}
      />
      <DeliveryIdFilter />
      <TimeFilter defaultPeriod="7d" />
      {hasFilters ? (
        <Button
          variant="minimal/small"
          LeadingIcon={XMarkIcon}
          tooltip="Clear all filters"
          className="group-hover/button:bg-transparent"
          leadingIconClassName="group-hover/button:text-text-bright"
          onClick={() => del([...CLEARABLE_PARAMS, "cursor", "direction"])}
        />
      ) : null}
    </div>
  );
}

/** Matches a delivery's ID or the provider's own delivery ID (e.g. GitHub's X-GitHub-Delivery). */
function DeliveryIdFilter() {
  const { value, del } = useSearchParams();
  const deliveryId = value(DELIVERY_ID_PARAM);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: DELIVERY_ID_SHORTCUT,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <IdFilterDropdown
          trigger={
            <Ariakit.TooltipProvider timeout={200}>
              <Ariakit.TooltipAnchor
                render={
                  <Ariakit.Select
                    ref={triggerRef}
                    render={<div className="group cursor-pointer focus-custom" />}
                  />
                }
              >
                {deliveryId ? (
                  <AppliedFilter
                    label="Delivery ID"
                    icon={<FingerPrintIcon className="size-4" />}
                    value={<span className="block max-w-[24ch] truncate">{deliveryId}</span>}
                    onRemove={() => del([DELIVERY_ID_PARAM, "cursor", "direction"])}
                    variant="secondary/small"
                    className="pl-1"
                  />
                ) : (
                  <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright transition group-hover:border-charcoal-550 group-hover:bg-charcoal-600">
                    <FingerPrintIcon className="size-4" />
                    <span>Delivery ID</span>
                  </div>
                )}
              </Ariakit.TooltipAnchor>
              <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span>Filter by delivery ID</span>
                  <ShortcutKey
                    className="size-4 flex-none"
                    shortcut={DELIVERY_ID_SHORTCUT}
                    variant="small"
                  />
                </div>
              </Ariakit.Tooltip>
            </Ariakit.TooltipProvider>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          label="Delivery ID or external ID"
          placeholder="whd_…"
          paramKey={DELIVERY_ID_PARAM}
        />
      )}
    </FilterMenuProvider>
  );
}
