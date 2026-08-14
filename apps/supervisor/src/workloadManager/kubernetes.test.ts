import { describe, expect, it } from "vitest";
import {
  BLOCK_IO_URING_SECCOMP_PROFILE,
  nodetypeNodeSelector,
  resolveRunPodBandwidthCap,
  runPodBandwidthAnnotations,
  runPodTolerations,
  withBlockIoUringSeccompProfile,
} from "./kubernetesPodSpec.js";

const basePodSpec = {
  restartPolicy: "Never" as const,
  automountServiceAccountToken: false,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    fsGroup: 1000,
  },
};

describe("nodetypeNodeSelector", () => {
  it("omits the nodeSelector entirely when the label is empty or unset", () => {
    for (const label of ["", undefined]) {
      expect(nodetypeNodeSelector(label)).toEqual({});
    }
  });

  it("pins to nodetype=<label> when set", () => {
    expect(nodetypeNodeSelector("v4-worker")).toEqual({ nodeSelector: { nodetype: "v4-worker" } });
  });
});

describe("runPodTolerations", () => {
  const worker = [{ key: "dedicated", operator: "Equal", value: "runs", effect: "NoSchedule" }];
  const scheduled = [{ key: "scheduled-runs", operator: "Exists", effect: "NoSchedule" }];

  it("leaves tolerations unset when neither is configured", () => {
    expect(runPodTolerations(undefined, undefined, false)).toBeUndefined();
    expect(runPodTolerations(undefined, undefined, true)).toBeUndefined();
    expect(runPodTolerations([], [], true)).toBeUndefined();
  });

  it("applies the worker tolerations to every run", () => {
    expect(runPodTolerations(worker, undefined, false)).toEqual(worker);
    expect(runPodTolerations(worker, undefined, true)).toEqual(worker);
  });

  it("applies the scheduled-run tolerations on their own, as before this option existed", () => {
    expect(runPodTolerations(undefined, scheduled, true)).toEqual(scheduled);
    expect(runPodTolerations(undefined, scheduled, false)).toBeUndefined();
    expect(runPodTolerations([], scheduled, true)).toEqual(scheduled);
  });

  it("adds the scheduled-run tolerations only for scheduled runs", () => {
    expect(runPodTolerations(worker, scheduled, false)).toEqual(worker);
    expect(runPodTolerations(worker, [], true)).toEqual(worker);
    expect(runPodTolerations(worker, scheduled, true)).toEqual([...worker, ...scheduled]);
  });
});

describe("withBlockIoUringSeccompProfile", () => {
  it("adds the Localhost io_uring profile for node-24 and above, preserving pod security defaults", () => {
    for (const runtime of ["node-24", "node-26", "node-30", "experimental-node-24"]) {
      const podSpec = withBlockIoUringSeccompProfile(basePodSpec, runtime);

      expect(podSpec).toMatchObject({
        ...basePodSpec,
        securityContext: {
          ...basePodSpec.securityContext,
          seccompProfile: {
            type: "Localhost",
            localhostProfile: BLOCK_IO_URING_SECCOMP_PROFILE,
          },
        },
      });
    }
  });

  it("leaves the pod spec unchanged for runtimes that do not create io_uring fds", () => {
    for (const runtime of ["node", "node-22", "bun", undefined, null, ""]) {
      expect(withBlockIoUringSeccompProfile(basePodSpec, runtime)).toEqual(basePodSpec);
    }
  });
});

describe("runPodBandwidthAnnotations", () => {
  it("returns undefined when neither cap is set", () => {
    expect(runPodBandwidthAnnotations(undefined, undefined)).toBeUndefined();
    expect(runPodBandwidthAnnotations("", "")).toBeUndefined();
  });

  it("includes only the caps that are set", () => {
    expect(runPodBandwidthAnnotations("100M", undefined)).toEqual({
      "kubernetes.io/egress-bandwidth": "100M",
    });
    expect(runPodBandwidthAnnotations(undefined, "200M")).toEqual({
      "kubernetes.io/ingress-bandwidth": "200M",
    });
  });

  it("includes both caps when both are set", () => {
    expect(runPodBandwidthAnnotations("100M", "200M")).toEqual({
      "kubernetes.io/egress-bandwidth": "100M",
      "kubernetes.io/ingress-bandwidth": "200M",
    });
  });
});

describe("resolveRunPodBandwidthCap", () => {
  it("prefers the preset override over the global cap", () => {
    expect(resolveRunPodBandwidthCap("25M", "100M")).toBe("25M");
  });

  it("falls back to the global cap when no override is set", () => {
    expect(resolveRunPodBandwidthCap(undefined, "100M")).toBe("100M");
    expect(resolveRunPodBandwidthCap(undefined, undefined)).toBeUndefined();
  });

  it("treats an empty override as a per-preset disable, not inherit", () => {
    const resolved = resolveRunPodBandwidthCap("", "100M");
    expect(resolved).toBe("");
    expect(runPodBandwidthAnnotations(resolved, resolved)).toBeUndefined();
  });
});
