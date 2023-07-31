// EventFilter is typed as type EventFilter = { [key: string]: EventFilter | string[] | number[] | boolean[] }

import { EventFilter } from "./schemas";

// This function should take any number of EventFilters and return a new EventFilter that is the result of merging of them.
export function deepMergeFilters(...filters: EventFilter[]): EventFilter {
  const result: EventFilter = {};

  for (const filter of filters) {
    for (const key in filter) {
      if (filter.hasOwnProperty(key)) {
        const filterValue = filter[key];
        const existingValue = result[key];

        if (
          existingValue &&
          typeof existingValue === "object" &&
          typeof filterValue === "object" &&
          !Array.isArray(existingValue) &&
          !Array.isArray(filterValue) &&
          existingValue !== null &&
          filterValue !== null
        ) {
          result[key] = deepMergeFilters(existingValue, filterValue);
        } else {
          result[key] = filterValue;
        }
      }
    }
  }

  return result;
}
