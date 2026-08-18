import { describe, expect, it } from "vitest";
import {
  nodetypeNodeSelector,
  runPodTolerations,
  withRunnerSeccompProfile,
  withNodeSelector,
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

  it("appends the org tolerations regardless of run type", () => {
    const org = [{ key: "dedicated", operator: "Equal", value: "org-pool", effect: "NoSchedule" }];

    expect(runPodTolerations(undefined, undefined, false, org)).toEqual(org);
    expect(runPodTolerations(worker, undefined, false, org)).toEqual([...worker, ...org]);
    expect(runPodTolerations(worker, scheduled, true, org)).toEqual([
      ...worker,
      ...scheduled,
      ...org,
    ]);
    expect(runPodTolerations(undefined, undefined, false, [])).toBeUndefined();
  });
});

describe("withNodeSelector", () => {
  const podSpec = { ...basePodSpec, nodeSelector: { nodetype: "v4-worker", paid: "true" } };

  it("returns the pod spec untouched when there is nothing to merge", () => {
    expect(withNodeSelector(podSpec, undefined)).toBe(podSpec);
    expect(withNodeSelector(podSpec, {})).toBe(podSpec);
  });

  it("merges extra entries with existing ones", () => {
    expect(withNodeSelector(podSpec, { machinepool: "dedicated-pool" })).toEqual({
      ...podSpec,
      nodeSelector: { nodetype: "v4-worker", paid: "true", machinepool: "dedicated-pool" },
    });
  });

  it("lets the extra entries win on key collision", () => {
    expect(withNodeSelector(podSpec, { nodetype: "other" }).nodeSelector).toEqual({
      nodetype: "other",
      paid: "true",
    });
  });

  it("adds a nodeSelector to a spec that had none", () => {
    expect(withNodeSelector(basePodSpec, { machinepool: "dedicated-pool" })).toEqual({
      ...basePodSpec,
      nodeSelector: { machinepool: "dedicated-pool" },
    });
  });
});

describe("withRunnerSeccompProfile", () => {
  const base = {
    profilePath: "profiles/example.json",
    runtimes: "node-24-plus" as const,
    runtime: "node-24",
    checkpointsEnabled: true,
  };

  const withProfile = {
    ...basePodSpec,
    securityContext: {
      ...basePodSpec.securityContext,
      seccompProfile: { type: "Localhost", localhostProfile: "profiles/example.json" },
    },
  };

  it("applies the profile to node-24 and above under the default scope", () => {
    for (const runtime of ["node-24", "node-26", "node-30", "experimental-node-24"]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtime })).toMatchObject(
        withProfile
      );
    }
  });

  it("skips older runtimes under the default scope", () => {
    for (const runtime of ["node", "node-22", "bun", undefined, null, ""]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtime })).toBe(basePodSpec);
    }
  });

  it("applies the profile to every runtime under the all scope", () => {
    for (const runtime of ["node", "node-22", "bun", "node-24", undefined]) {
      expect(
        withRunnerSeccompProfile(basePodSpec, { ...base, runtimes: "all", runtime })
      ).toMatchObject(withProfile);
    }
  });

  it("applies nothing under the none scope, whatever the runtime", () => {
    for (const runtime of ["node-24", "bun", "node-22"]) {
      expect(withRunnerSeccompProfile(basePodSpec, { ...base, runtimes: "none", runtime })).toBe(
        basePodSpec
      );
    }
  });

  it("applies nothing when checkpoints are disabled", () => {
    for (const runtimes of ["none", "node-24-plus", "all"] as const) {
      expect(
        withRunnerSeccompProfile(basePodSpec, { ...base, runtimes, checkpointsEnabled: false })
      ).toBe(basePodSpec);
    }
  });
});
