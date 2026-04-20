import { useMemo, useState } from "react";
import { matchSorter } from "match-sorter";

/**
 * A hook that provides fuzzy filtering functionality for a list of objects.
 * Uses match-sorter to perform the filtering across multiple object properties and
 * consistently order the results by score.
 *
 * @param params - The parameters object
 * @param params.items - Array of objects to filter
 * @param params.keys - Array of object keys to perform the fuzzy search on (supports dot-notation for nested properties)
 * @returns An object containing:
 *   - filterText: The current filter text
 *   - setFilterText: Function to update the filter text
 *   - filteredItems: The filtered array of items based on the current filter text
 *
 * @example
 * ```tsx
 * const users = [{ name: "John", email: "john@example.com" }];
 * const { filterText, setFilterText, filteredItems } = useFuzzyFilter({
 *   items: users,
 *   keys: ["name", "email"]
 * });
 * ```
 */
export function useFuzzyFilter<T extends Object>({
  items,
  keys,
  filterText: controlledFilterText,
}: {
  items: T[];
  keys: (Extract<keyof T, string> | (string & {}))[];
  /** Optional controlled filter text. If provided, internal state is ignored. */
  filterText?: string;
}) {
  const [internalFilterText, setInternalFilterText] = useState("");
  const filterText = controlledFilterText ?? internalFilterText;

  const filteredItems = useMemo<T[]>(() => {
    const filterTerms = filterText
      .trim()
      .split(" ")
      .map((term) => term.trim())
      .filter((term) => term !== "");

    if (filterTerms.length === 0) {
      return items;
    }

    return filterTerms.reduceRight(
      (results, term) =>
        matchSorter(results, term, {
          keys,
        }),
      items
    );
  }, [items, filterText]);

  return {
    filterText,
    setFilterText: setInternalFilterText,
    filteredItems,
  };
}
