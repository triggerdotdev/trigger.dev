import { WorkerInstanceGroupType } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { isWorkerGroupAllowedForProject } from "../app/v3/services/worker/workerGroupAccess.js";

// UNMANAGED worker groups are per-project; MANAGED are shared. A project must
// not be able to route onto another project's UNMANAGED group.
describe("isWorkerGroupAllowedForProject", () => {
  it("allows an UNMANAGED group owned by the calling project", () => {
    const group = { type: WorkerInstanceGroupType.UNMANAGED, projectId: "proj_me" };
    expect(isWorkerGroupAllowedForProject(group, "proj_me")).toBe(true);
  });

  it("rejects an UNMANAGED group owned by a different project (the cross-tenant vector)", () => {
    const group = { type: WorkerInstanceGroupType.UNMANAGED, projectId: "proj_other" };
    expect(isWorkerGroupAllowedForProject(group, "proj_me")).toBe(false);
  });

  it("allows MANAGED (shared) groups regardless of project", () => {
    const group = { type: WorkerInstanceGroupType.MANAGED, projectId: null };
    expect(isWorkerGroupAllowedForProject(group, "proj_me")).toBe(true);
  });
});
