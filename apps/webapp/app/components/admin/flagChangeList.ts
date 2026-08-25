import { derivedFlagsClearedWith } from "~/v3/featureFlags";

export type FlagChange =
  | { key: string; type: "added"; newVal: string }
  | { key: string; type: "removed"; oldVal: string }
  | { key: string; type: "changed"; oldVal: string; newVal: string };

/**
 * What a global flag save will do, for the confirm dialog.
 *
 * A graced primary that is unset also clears its stamps. Those keys are locked, so the caller
 * filters them out of `initialValues` — the cascade therefore reads `storedValues`, which is the
 * unfiltered set the loader returned. Reading `initialValues` finds nothing and understates the
 * deletion, which is the defect this parameter exists to prevent.
 */
export function buildFlagChangeList(params: {
  editableKeys: readonly string[];
  lockedKeys: readonly string[];
  initialValues: Record<string, unknown>;
  storedValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}): FlagChange[] {
  const { editableKeys, initialValues, storedValues, newValues } = params;

  return editableKeys.flatMap<FlagChange>((key) => {
    const wasSet = key in initialValues;
    const isSet = key in newValues;
    const oldVal = initialValues[key];
    const newVal = newValues[key];

    if (!wasSet && !isSet) return [];
    if (wasSet && isSet && stableValue(oldVal) === stableValue(newVal)) return [];

    if (!wasSet && isSet) {
      return [{ key, type: "added", newVal: String(newVal) }];
    }

    if (wasSet && !isSet) {
      // Only an unset clears the stamps. A change re-stamps instead.
      const cascaded = derivedFlagsClearedWith(key)
        .filter((derived) => derived in storedValues)
        .map<FlagChange>((derived) => ({
          key: derived,
          type: "removed",
          oldVal: String(storedValues[derived]),
        }));
      return [{ key, type: "removed", oldVal: String(oldVal) }, ...cascaded];
    }

    return [{ key, type: "changed", oldVal: String(oldVal), newVal: String(newVal) }];
  });
}

function stableValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}
