// EventFilter is typed as type EventFilter = { [key: string]: EventFilter | string[] | number[] | boolean[] }

import { EventFilter } from "./schemas";

// This function should take two EventFilters and return a new EventFilter that is the result of merging the two.
export function deepMergeFilters(
  filter: EventFilter,
  other: EventFilter
): EventFilter {
  const result: EventFilter = { ...filter };

  for (const key in other) {
    if (other.hasOwnProperty(key)) {
      const otherValue = other[key];

      if (
        typeof otherValue === "object" &&
        !Array.isArray(otherValue) &&
        otherValue !== null
      ) {
        const filterValue = filter[key];

        if (
          filterValue &&
          typeof filterValue === "object" &&
          !Array.isArray(filterValue)
        ) {
          result[key] = deepMergeFilters(filterValue, otherValue);
        } else {
          result[key] = { ...other[key] };
        }
      } else {
        result[key] = other[key];
      }
    }
  }

  return result;
}
