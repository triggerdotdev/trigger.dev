import { DocumentTextIcon } from "@heroicons/react/20/solid";
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

const shortcut = { key: "p" };

interface PromptsFilterProps {
  possiblePrompts: string[];
}

export function PromptsFilter({ possiblePrompts }: PromptsFilterProps) {
  const { values, replace, del } = useSearchParams();
  const selectedPrompts = values("prompts");

  if (selectedPrompts.length === 0 || selectedPrompts.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <PromptsDropdown
            trigger={
              <SelectTrigger
                icon={<DocumentTextIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by prompt"
              >
                <span className="ml-0.5">Prompts</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
            possiblePrompts={possiblePrompts}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <PromptsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Prompt"
                icon={<DocumentTextIcon className="size-4" />}
                value={appliedSummary(selectedPrompts)}
                onRemove={() => del(["prompts"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possiblePrompts={possiblePrompts}
        />
      )}
    </FilterMenuProvider>
  );
}

function PromptsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possiblePrompts,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possiblePrompts: string[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ prompts: values });
  };

  const filtered = useMemo(() => {
    return possiblePrompts.filter((p) => {
      return p.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possiblePrompts]);

  return (
    <SelectProvider value={values("prompts")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder="Filter by prompt..." value={searchValue} />
        <SelectList>
          {filtered.map((slug) => (
            <SelectItem key={slug} value={slug} className="text-text-bright" icon={<DocumentTextIcon className="size-4 text-text-dimmed" />}>
              {slug}
            </SelectItem>
          ))}
          {filtered.length === 0 && <SelectItem disabled>No prompts found</SelectItem>}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
