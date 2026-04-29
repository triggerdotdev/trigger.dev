import * as Ariakit from "@ariakit/react";
import { SelectTrigger } from "~/components/primitives/Select";
import { useSearchParams } from "~/hooks/useSearchParam";
import { appliedSummary, FilterMenuProvider } from "~/components/runs/v3/SharedFilters";
import { filterIcon, VersionsDropdown } from "~/components/runs/v3/RunFilters";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";

const shortcut = { key: "v" };

export function LogsVersionFilter() {
  const { values, del } = useSearchParams();
  const selectedVersions = values("versions");

  if (selectedVersions.length === 0 || selectedVersions.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <VersionsDropdown
            trigger={
              <SelectTrigger
                icon={filterIcon("versions")}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by version"
              >
                <span className="ml-0.5">Versions</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <VersionsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Versions"
                icon={filterIcon("versions")}
                value={appliedSummary(selectedVersions)}
                onRemove={() => del(["versions", "cursor", "direction"])}
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
