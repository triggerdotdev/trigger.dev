// `source: "code"` is reserved for the deploy path; no other caller may write
// it. Normalize anything that isn't a legitimate caller-supplied value to
// "dashboard". Dependency-free so the rule can be unit-tested directly; it
// backs the service-layer check (the route layer also constrains `source`).
export function normalizePromptOverrideSource(source: string | undefined | null): string {
  return source && source !== "code" ? source : "dashboard";
}
