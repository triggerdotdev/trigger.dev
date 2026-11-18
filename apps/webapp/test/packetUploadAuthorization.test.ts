import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { packetUploadResources } from "~/services/packetApi.server";
import { anyResource, checkAuth } from "~/services/routeBuilders/apiBuilder.server";

describe("run-scoped packet uploads", () => {
  // Catches: output offloading requiring environment-wide packet access, or authorizing foreign keys.
  it("grants only output keys under an authorized run's attempt prefix", () => {
    const ability = buildJwtAbility(["write:runs:run_self"]);
    const canUpload = (path: string) =>
      checkAuth(ability, "write", anyResource(packetUploadResources(path)));

    expect(canUpload("run_self-1/output.json")).toBe(true);
    expect(canUpload("s3://run_self-12/output.txt")).toBe(true);
    for (const path of [
      "run_other-1/output.json",
      "run_self_extra-1/output.json",
      "run_self-1/payload.json",
      "run_self-0/output.json",
      "run_self-01/output.json",
      "run_self-1/output.json\n",
      "/run_self-1/output.json",
      "run_self-1/../run_other-1/output.json",
      "run_self-1/output.json/../../run_other-1/output.json",
      "run_self-1\\output.json",
      "run_self-1/%2e%2e/run_other-1/output.json",
      "run_self-1%2foutput.json",
      "run_self-1/output.json%2f..%2f..%2frun_other-1/output.json",
    ]) {
      expect(canUpload(path), path).toBe(false);
    }

    expect(
      checkAuth(
        buildJwtAbility(["write:packets"]),
        "write",
        anyResource(packetUploadResources("trigger/task/payload.json"))
      )
    ).toBe(true);
  });
});
