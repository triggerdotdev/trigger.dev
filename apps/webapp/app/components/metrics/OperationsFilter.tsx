import { CommandLineIcon } from "@heroicons/react/20/solid";
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

const shortcut = { key: "n" };

interface OperationsFilterProps {
  possibleOperations: string[];
}

/** Pretty-print an operation ID like "ai.generateText.doGenerate" → "generateText" */
function formatOperation(op: string): string {
  const parts = op.split(".");
  // ai.generateText.doGenerate → generateText
  // ai.streamText.doStream → streamText
  if (parts.length >= 2 && parts[0] === "ai") {
    return parts[1];
  }
  return op;
}

export function OperationsFilter({ possibleOperations }: OperationsFilterProps) {
  const { values, replace, del } = useSearchParams();
  const selectedOperations = values("operations");

  if (selectedOperations.length === 0 || selectedOperations.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <OperationsDropdown
            trigger={
              <SelectTrigger
                icon={<CommandLineIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by operation"
              >
                <span className="ml-0.5">Operations</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
            possibleOperations={possibleOperations}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <OperationsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Operation"
                icon={<CommandLineIcon className="size-4" />}
                value={appliedSummary(selectedOperations.map(formatOperation))}
                onRemove={() => del(["operations"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleOperations={possibleOperations}
        />
      )}
    </FilterMenuProvider>
  );
}

function OperationsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleOperations,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleOperations: string[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ operations: values });
  };

  const filtered = useMemo(() => {
    const q = searchValue.toLowerCase();
    return possibleOperations.filter(
      (op) => op.toLowerCase().includes(q) || formatOperation(op).toLowerCase().includes(q)
    );
  }, [searchValue, possibleOperations]);

  return (
    <SelectProvider value={values("operations")} setValue={handleChange} virtualFocus={true}>
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
        <ComboBox placeholder="Filter by operation..." value={searchValue} />
        <SelectList>
          {filtered.map((op) => (
            <SelectItem key={op} value={op} className="text-text-bright" icon={<CommandLineIcon className="size-4 text-text-dimmed" />}>
              {formatOperation(op)}
            </SelectItem>
          ))}
          {filtered.length === 0 && <SelectItem disabled>No operations found</SelectItem>}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
