import { EventFilter } from "./schemas/eventFilter";

// EventFilter is a recursive type, where the keys are strings and the values are an array of strings, numbers, booleans, or objects.
// If the values of the array are strings, numbers, or booleans, than we are matching against the value of the payload.
// If the values of the array are objects, then we are doing content filtering
// An example would be [{ $endsWith: ".png" }, { $startsWith: "images/" } ]
export function eventFilterMatches(payload: any, filter: EventFilter): boolean {
  for (const [patternKey, patternValue] of Object.entries(filter)) {
    const payloadValue = payload[patternKey];

    if (Array.isArray(patternValue)) {
      if (patternValue.length === 0) {
        continue;
      }

      // Check to see if all the items in the array are a string
      if ((patternValue as unknown[]).every((item) => typeof item === "string")) {
        if ((patternValue as string[]).includes(payloadValue)) {
          continue;
        }

        return false;
      }

      // Check to see if all the items in the array are a number
      if ((patternValue as unknown[]).every((item) => typeof item === "number")) {
        if ((patternValue as number[]).includes(payloadValue)) {
          continue;
        }

        return false;
      }

      // Check to see if all the items in the array are a boolean
      if ((patternValue as unknown[]).every((item) => typeof item === "boolean")) {
        if ((patternValue as boolean[]).includes(payloadValue)) {
          continue;
        }

        return false;
      }

      // Now we know that all the items in the array are objects
      const objectArray = patternValue as Exclude<
        typeof patternValue,
        number[] | string[] | boolean[]
      >;

      if (!contentFiltersMatches(payloadValue, objectArray)) {
        return false;
      }

      continue;
    } else if (typeof patternValue === "object") {
      if (Array.isArray(payloadValue)) {
        if (!payloadValue.some((item) => eventFilterMatches(item, patternValue))) {
          return false;
        }
      } else {
        if (!eventFilterMatches(payloadValue, patternValue)) {
          return false;
        }
      }
    }
  }
  return true;
}

type ContentFilters = Exclude<EventFilter[string], EventFilter | string[] | number[] | boolean[]>;

function contentFiltersMatches(actualValue: any, contentFilters: ContentFilters): boolean {
  for (const contentFilter of contentFilters) {
    if (typeof contentFilter === "object") {
      const [key, value] = Object.entries(contentFilter)[0];

      if (!contentFilterMatches(actualValue, contentFilter)) {
        return false;
      }
    }
  }

  return true;
}

function contentFilterMatches(actualValue: any, contentFilter: ContentFilters[number]): boolean {
  if ("$endsWith" in contentFilter) {
    if (typeof actualValue !== "string") {
      return false;
    }

    return actualValue.endsWith(contentFilter.$endsWith);
  }

  if ("$startsWith" in contentFilter) {
    if (typeof actualValue !== "string") {
      return false;
    }

    return actualValue.startsWith(contentFilter.$startsWith);
  }

  if ("$anythingBut" in contentFilter) {
    if (Array.isArray(contentFilter.$anythingBut)) {
      if ((contentFilter.$anythingBut as any[]).includes(actualValue)) {
        return false;
      }
    }

    if (contentFilter.$anythingBut === actualValue) {
      return false;
    }

    return true;
  }

  if ("$exists" in contentFilter) {
    if (contentFilter.$exists) {
      return actualValue !== undefined;
    }

    return actualValue === undefined;
  }

  if ("$gt" in contentFilter) {
    if (typeof actualValue !== "number") {
      return false;
    }

    return actualValue > contentFilter.$gt;
  }

  if ("$lt" in contentFilter) {
    if (typeof actualValue !== "number") {
      return false;
    }

    return actualValue < contentFilter.$lt;
  }

  if ("$gte" in contentFilter) {
    if (typeof actualValue !== "number") {
      return false;
    }

    return actualValue >= contentFilter.$gte;
  }

  if ("$lte" in contentFilter) {
    if (typeof actualValue !== "number") {
      return false;
    }

    return actualValue <= contentFilter.$lte;
  }

  if ("$between" in contentFilter) {
    if (typeof actualValue !== "number") {
      return false;
    }

    return actualValue >= contentFilter.$between[0] && actualValue <= contentFilter.$between[1];
  }

  if ("$includes" in contentFilter) {
    if (Array.isArray(actualValue)) {
      return actualValue.includes(contentFilter.$includes);
    }

    return false;
  }

  // Use localCompare
  if ("$ignoreCaseEquals" in contentFilter) {
    if (typeof actualValue !== "string") {
      return false;
    }

    return (
      actualValue.localeCompare(contentFilter.$ignoreCaseEquals, undefined, {
        sensitivity: "accent",
      }) === 0
    );
  }

  return true;
}
