import { ServerIcon } from "@heroicons/react/20/solid";
import * as Ariakit from "@ariakit/react";
import { type ReactNode, useMemo } from "react";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { appliedSummary, FilterMenuProvider } from "~/components/runs/v3/SharedFilters";

const shortcut = { key: "v" };

interface ProvidersFilterProps {
  possibleProviders: string[];
}

export function ProvidersFilter({ possibleProviders }: ProvidersFilterProps) {
  const { values, replace, del } = useSearchParams();
  const selectedProviders = values("providers");

  if (selectedProviders.length === 0 || selectedProviders.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <ProvidersDropdown
            trigger={
              <SelectTrigger
                icon={<ServerIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by provider"
              >
                <span className="ml-0.5">Providers</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
            possibleProviders={possibleProviders}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ProvidersDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Provider"
                icon={<ServerIcon className="size-4" />}
                value={appliedSummary(selectedProviders)}
                onRemove={() => del(["providers"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleProviders={possibleProviders}
        />
      )}
    </FilterMenuProvider>
  );
}

function ProvidersDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleProviders,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleProviders: string[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ providers: values });
  };

  const filtered = useMemo(() => {
    return possibleProviders.filter((p) => p.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue, possibleProviders]);

  return (
    <SelectProvider value={values("providers")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder="Filter by provider..." value={searchValue} />
        <SelectList>
          {filtered.map((provider) => (
            <SelectItem key={provider} value={provider} icon={<ServerIcon className="size-4" />}>
              {provider}
            </SelectItem>
          ))}
          {filtered.length === 0 && <SelectItem disabled>No providers found</SelectItem>}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
