import { useMemo, useState } from "react";
import { matchSorter } from "match-sorter";

/**
 * A hook that provides fuzzy filtering functionality for a list of objects.
 * Uses match-sorter to perform the filtering across multiple object properties and
 * consistently order the results by score.
 *
 * @param params - The parameters object
 * @param params.items - Array of objects to filter
 * @param params.keys - Array of object keys to perform the fuzzy search on
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
}: {
  items: T[];
  keys: Extract<keyof T, string>[];
}) {
  const [filterText, setFilterText] = useState("");

  const filteredItems = useMemo<T[]>(() => {
    const filterTerms = filterText
      .trim()
      .split(" ")
      .map((term) => term.trim())
      .filter((term) => term !== "");

    if (filterTerms.length === 0) {
      return items;
    }

    // sort by the score of the first term
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
    setFilterText,
    filteredItems,
  };
}
