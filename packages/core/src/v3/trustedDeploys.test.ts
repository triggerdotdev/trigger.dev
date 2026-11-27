import { describe, expect, it } from "vitest";
import { PrepareTrustedDeployResponse } from "./trustedDeploys.js";

describe("PrepareTrustedDeployResponse", () => {
  // Catches: a malformed CLI version policy failing the whole parse, which would stop trusted deploys from uploading.
  it("drops a malformed policy but keeps the upload details", () => {
    const artifact = {
      artifactKey: "artifact_key",
      uploadUrl: "https://uploads.example.com",
      uploadFields: { key: "value" },
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    expect(
      PrepareTrustedDeployResponse.parse({ ...artifact, cliVersionPolicy: { minimum: "4.5.20" } })
    ).toEqual(artifact);
  });
});
