import { describe, expect, it } from "vitest";
import {
  isSecretProxyHostname,
  SecretProxyPlacementPendingError,
  trustedSecretProxyIdentity,
} from "./secretProxyBindings.js";
import { deploymentClaims } from "./fixtures/secretProxy.js";

describe("secret proxy warm placement", () => {
  const runner = {
    metadata: { name: "runner-bootstrap", uid: "runner-uid", namespace: "runners" },
    spec: {
      runtime: "microvm",
      owner: { envID: deploymentClaims.environment_id },
      deployment: { friendlyID: deploymentClaims.deployment },
      bootstrap: { runFriendlyID: "run_bootstrap" },
    },
  };
  const pod = {
    metadata: {
      name: "runner-bootstrap",
      uid: "pod-uid",
      namespace: "runners",
      ownerReferences: [
        {
          kind: "Runner",
          apiVersion: "compute.trigger.dev/v1alpha1",
          name: "runner-bootstrap",
          uid: "runner-uid",
          controller: true,
        },
      ],
    },
    spec: { nodeName: "node-1", containers: [{ name: "runner" }] },
    status: {
      podIP: "10.0.0.1",
      containerStatuses: [
        {
          name: "runner",
          ready: true,
          restartCount: 0,
          image: "test",
          imageID: "test",
          containerID: "containerd://guest-1",
          state: { running: {} },
        },
      ],
    },
  };
  const caller = {
    runId: "run_warm",
    runnerId: "runner-bootstrap",
    sourceIp: "10.0.0.1",
    claims: deploymentClaims,
  };

  it("only treats missing Pod status as pending after validating identity", () => {
    const verify = (
      status: Omit<typeof pod.status, "podIP"> & { podIP?: string },
      input = caller
    ) => trustedSecretProxyIdentity(runner, { ...pod, status }, input, "node-1", "runners");
    const noPodIP = { ...pod.status, podIP: undefined };
    const noContainerID = {
      ...pod.status,
      containerStatuses: [{ ...pod.status.containerStatuses[0]!, containerID: "" }],
    };
    expect(() => verify(noPodIP)).toThrow(SecretProxyPlacementPendingError);
    expect(() => verify(noContainerID)).toThrow(SecretProxyPlacementPendingError);
    expect(() => verify(noContainerID, { ...caller, sourceIp: "10.0.0.2" })).toThrow(
      "Secret proxy execution unavailable"
    );
    expect(() =>
      verify(noPodIP, {
        ...caller,
        claims: { ...deploymentClaims, deployment: "deployment_other" },
      })
    ).toThrow("Secret proxy execution unavailable");
  });

  it("admits another run only inside the VM's environment and deployment", () => {
    const verify = (input = caller, vm = runner) =>
      trustedSecretProxyIdentity(vm, pod, input, "node-1", "runners");
    expect(verify()).toMatchObject({
      bootstrapRunId: "run_bootstrap",
      guestId: "guest-1",
    });
    for (const claims of [
      { ...deploymentClaims, environment_id: "env_other" },
      { ...deploymentClaims, deployment: "deployment_other" },
    ])
      expect(() => verify({ ...caller, claims })).toThrow();
    expect(() => verify({ ...caller, sourceIp: "10.0.0.2" })).toThrow();
    expect(() =>
      trustedSecretProxyIdentity(
        { ...runner, spec: { ...runner.spec, singleUse: true } },
        pod,
        caller,
        "node-1",
        "runners"
      )
    ).toThrow();
    expect(() =>
      trustedSecretProxyIdentity(
        { ...runner, spec: { ...runner.spec, singleUse: true } },
        pod,
        { ...caller, runId: "run_bootstrap" },
        "node-1",
        "runners"
      )
    ).not.toThrow();
  });
});

describe("secret proxy hostnames", () => {
  it("accepts canonical DNS labels through the hostname length limit", () => {
    for (const host of [
      "api.example.com",
      "a--b.example.com",
      "xn--bcher-kva.example",
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join("."),
    ]) {
      expect(isSecretProxyHostname(host), host).toBe(true);
    }
  });

  it("rejects IPs, noncanonical authorities, and oversized labels or hostnames", () => {
    for (const host of [
      "",
      "localhost",
      "API.example.com",
      "api.example.com.",
      "api..example.com",
      "-api.example.com",
      "api-.example.com",
      "api_name.example.com",
      "*.example.com",
      "api.example.com:443",
      "api.example.com:8443",
      "https://api.example.com",
      "127.0.0.1",
      "[::1]",
      `${"a".repeat(64)}.example.com`,
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join("."),
    ]) {
      expect(isSecretProxyHostname(host), host).toBe(false);
    }
  });
});
