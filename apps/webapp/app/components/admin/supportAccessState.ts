import type { SupportAccessMode } from "@trigger.dev/database";

export type SupportAccessState = "allow" | "approved" | "request";

export function supportAccessState(org: {
  supportAccessMode: SupportAccessMode;
  supportAccessRequests: unknown[];
  /** The access policy plugin treats this organization's support access as allowed. */
  supportAccessForced?: boolean;
}): SupportAccessState {
  if (org.supportAccessMode === "ALLOW" || org.supportAccessForced) return "allow";
  return org.supportAccessRequests.length > 0 ? "approved" : "request";
}
