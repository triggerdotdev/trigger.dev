import type { McpConfirmSpec, McpToolAuth } from "./types";

export function requiresApproval(auth: McpToolAuth): boolean | McpConfirmSpec {
  if ("public" in auth) return false;
  if (auth.confirm !== undefined) return auth.confirm;
  return auth.action !== "read";
}
