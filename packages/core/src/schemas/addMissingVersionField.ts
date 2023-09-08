export function addMissingVersionField(val: unknown) {
  if (val !== null && typeof val === "object" && !("version" in val)) {
    return {
      ...val,
      version: "1",
    };
  }
  return val;
}
