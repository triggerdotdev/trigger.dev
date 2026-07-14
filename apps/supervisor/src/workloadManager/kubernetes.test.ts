import { describe, expect, it } from "vitest";
import { withRuntimeDefaultSeccompProfile } from "./kubernetesPodSpec.js";

describe("withRuntimeDefaultSeccompProfile", () => {
  it("adds RuntimeDefault seccomp while preserving pod security defaults", () => {
    const podSpec = withRuntimeDefaultSeccompProfile({
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        fsGroup: 1000,
      },
    });

    expect(podSpec).toMatchObject({
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        fsGroup: 1000,
        seccompProfile: {
          type: "RuntimeDefault",
        },
      },
    });
  });
});
