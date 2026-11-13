/**
 * The trigger-time `concurrencyKey`. Anything but a key map is sent as given. A key
 * map needs a `default`, and every entry needs a non-empty string or finite number, which
 * is sent as a string.
 */
export function triggerConcurrencyKeyBody(
  concurrencyKey: string | Record<string, string> | undefined
): { concurrencyKey?: string | Record<string, string> } {
  if (!isKeyMap(concurrencyKey)) {
    return { concurrencyKey };
  }
  const keys: Record<string, string> = {};
  for (const [name, key] of Object.entries(concurrencyKey as Record<string, unknown>)) {
    const usable =
      (typeof key === "string" && key !== "") || (typeof key === "number" && Number.isFinite(key));
    if (name === "__proto__" || (name !== "default" && !usable)) {
      throw new Error(
        `concurrencyKey entry "${name}" needs a limit name and a key that is a non-empty string or number.`
      );
    }
    if (usable) {
      keys[name] = String(key);
    }
  }
  if (!keys.default) {
    throw new Error(
      "concurrencyKey needs a `default` key: runs are queued and scheduled fairly per default key, and limits without their own entry use it."
    );
  }
  return { concurrencyKey: keys };
}

/**
 * Any object that serialises as an object. Arrays and objects with a `toJSON` (dates, id
 * objects) serialise to something else, so they are sent as given.
 */
function isKeyMap(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { toJSON?: unknown }).toJSON !== "function"
  );
}
