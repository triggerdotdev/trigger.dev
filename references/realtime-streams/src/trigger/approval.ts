import { task, metadata } from "@trigger.dev/sdk";
import { approvalInputStream } from "../app/streams";

export const approvalTask = task({
  id: "approval-flow",
  run: async () => {
    metadata.set("status", "waiting-for-approval");

    const result = await approvalInputStream.wait({ timeout: "5m" });

    if (result.ok) {
      metadata.set("status", result.output.approved ? "approved" : "rejected");
      metadata.set("reviewer", result.output.reviewer);
    } else {
      metadata.set("status", "timed-out");
    }

    return { approval: result };
  },
});
