import type { Organization, Project } from "@trigger.dev/database";
import { createEnvironment } from "~/models/organization.server";
import { getCurrentPlan, isCloud } from "~/services/platform.v3.server";

// Extracted from platform.v3.server.ts to break a circular import:
// platform.v3.server ↔ models/organization.server (via createEnvironment).
// The cycle caused the bundled __esm wrappers to re-enter and short-circuit
// the platform.v3.server init, leaving `defaultMachine` and `machines`
// undefined in `singleton("machinePresets", ...)` — the boot crash at
// `allMachines()` traced to TRI-8731.
export async function projectCreated(
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">,
  project: Project
) {
  if (!isCloud()) {
    await createEnvironment({ organization, project, type: "STAGING" });
    await createEnvironment({
      organization,
      project,
      type: "PREVIEW",
      isBranchableEnvironment: true,
    });
  } else {
    const plan = await getCurrentPlan(organization.id);
    if (plan?.v3Subscription.plan?.limits.hasStagingEnvironment) {
      await createEnvironment({ organization, project, type: "STAGING" });
      await createEnvironment({
        organization,
        project,
        type: "PREVIEW",
        isBranchableEnvironment: true,
      });
    }
  }
}
