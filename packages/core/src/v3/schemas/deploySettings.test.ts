import { describe, expect, it } from "vitest";
import { GetDeploySettingsResponseBody } from "./api.js";

describe("GetDeploySettingsResponseBody", () => {
  // Catches: a policy without its enforcement date being accepted, or failing the whole parse and moving the client to the default build path.
  it("drops a policy without an enforcement date but keeps the build path", () => {
    expect(
      GetDeploySettingsResponseBody.parse({
        build_path: "native",
        cli_version_policy: { minimum: "4.5.20" },
      })
    ).toEqual({ build_path: "native" });
  });
});
