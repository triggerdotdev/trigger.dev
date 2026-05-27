import { CubeIcon } from "@heroicons/react/20/solid";
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
import { tablerIcons } from "~/utils/tablerIcons";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import { AnthropicLogoIcon } from "~/assets/icons/AnthropicLogoIcon";

const shortcut = { key: "m" };

export type ModelOption = {
  model: string;
  system: string;
};

interface ModelsFilterProps {
  possibleModels: ModelOption[];
}

function modelIcon(system: string, model: string): ReactNode {
  // For gateway/openrouter, derive provider from model prefix
  let provider = system.split(".")[0];
  if (provider === "gateway" || provider === "openrouter") {
    if (model.includes("/")) {
      provider = model.split("/")[0].replace(/-/g, "");
    }
  }

  // Special case: Anthropic uses a custom SVG icon
  if (provider === "anthropic") {
    return <AnthropicLogoIcon className="size-4 shrink-0 text-text-dimmed" />;
  }

  const iconName = `tabler-brand-${provider}`;
  if (tablerIcons.has(iconName)) {
    return (
      <svg className="size-4 shrink-0 stroke-[1.5] text-text-dimmed">
        <use xlinkHref={`${tablerSpritePath}#${iconName}`} />
      </svg>
    );
  }

  return <CubeIcon className="size-4 shrink-0 text-text-dimmed" />;
}

export function ModelsFilter({ possibleModels }: ModelsFilterProps) {
  const { values, replace, del } = useSearchParams();
  const selectedModels = values("models");

  if (selectedModels.length === 0 || selectedModels.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <ModelsDropdown
            trigger={
              <SelectTrigger
                icon={<CubeIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by model"
                className="pl-1.5"
              >
                <span className="ml-1">Models</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
            possibleModels={possibleModels}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ModelsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Model"
                icon={<CubeIcon className="size-4" />}
                value={appliedSummary(selectedModels)}
                onRemove={() => del(["models"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleModels={possibleModels}
        />
      )}
    </FilterMenuProvider>
  );
}

function ModelsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleModels,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleModels: ModelOption[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ models: values });
  };

  const filtered = useMemo(() => {
    return possibleModels.filter((m) => {
      return m.model?.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleModels]);

  return (
    <SelectProvider value={values("models")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder="Filter by model..." value={searchValue} />
        <SelectList>
          {filtered.map((m) => (
            <SelectItem key={m.model} value={m.model} className="text-text-bright" icon={modelIcon(m.system, m.model)}>
              {m.model}
            </SelectItem>
          ))}
          {filtered.length === 0 && <SelectItem disabled>No models found</SelectItem>}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
