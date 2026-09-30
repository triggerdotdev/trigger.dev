import type { SupportAccessMode } from "@trigger.dev/database";

export type SupportAccessState = "allow" | "approved" | "request";

export function supportAccessState(org: {
  supportAccessMode: SupportAccessMode;
  supportAccessRequests: unknown[];
}): SupportAccessState {
  if (org.supportAccessMode === "ALLOW") return "allow";
  return org.supportAccessRequests.length > 0 ? "approved" : "request";
}
