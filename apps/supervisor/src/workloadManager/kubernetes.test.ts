import { describe, expect, it } from "vitest";
import {
  BLOCK_IO_URING_SECCOMP_PROFILE,
  runtimeRequiresSeccompProfile,
  withBlockIoUringSeccompProfile,
} from "./kubernetesPodSpec.js";

describe("runtimeRequiresSeccompProfile", () => {
  it("returns true for node-24 and above", () => {
    expect(runtimeRequiresSeccompProfile("node-24")).toBe(true);
    expect(runtimeRequiresSeccompProfile("node-26")).toBe(true);
    expect(runtimeRequiresSeccompProfile("node-30")).toBe(true);
    expect(runtimeRequiresSeccompProfile("experimental-node-24")).toBe(true);
  });

  it("returns false for runtimes that do not create io_uring fds", () => {
    expect(runtimeRequiresSeccompProfile("node")).toBe(false);
    expect(runtimeRequiresSeccompProfile("node-22")).toBe(false);
    expect(runtimeRequiresSeccompProfile("bun")).toBe(false);
    expect(runtimeRequiresSeccompProfile(undefined)).toBe(false);
    expect(runtimeRequiresSeccompProfile(null)).toBe(false);
    expect(runtimeRequiresSeccompProfile("")).toBe(false);
  });
});

describe("withBlockIoUringSeccompProfile", () => {
  it("adds the Localhost io_uring profile while preserving pod security defaults", () => {
    const podSpec = withBlockIoUringSeccompProfile({
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
          type: "Localhost",
          localhostProfile: BLOCK_IO_URING_SECCOMP_PROFILE,
        },
      },
    });
  });
});
