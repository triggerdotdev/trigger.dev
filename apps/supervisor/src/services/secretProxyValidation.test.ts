import { describe, expect, it } from "vitest";
import { isSecretProxyHostname, trustedSecretProxyIdentity } from "./secretProxyBindings.js";
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
    spec: {
      nodeName: "node-1",
      restartPolicy: "Never",
      containers: [
        {
          name: "runner",
          env: [
            {
              name: "TRIGGER_POD_IP",
              valueFrom: { fieldRef: { fieldPath: "status.podIP" } },
            },
            {
              name: "TRIGGER_POD_UID",
              valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
            },
          ],
        },
      ],
    },
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

  it("accepts absent status but refuses missing, literal or duplicated placement fields", () => {
    const container = pod.spec.containers[0]!;
    const verify = (
      env: {
        name: string;
        value?: string;
        valueFrom?: { fieldRef: { fieldPath: string } };
      }[]
    ) =>
      trustedSecretProxyIdentity(
        runner,
        {
          ...pod,
          status: {},
          spec: { ...pod.spec, containers: [{ ...container, env }] },
        },
        caller,
        "node-1",
        "runners"
      );
    expect(verify(container.env)).toMatchObject({ podUid: "pod-uid" });
    for (const field of container.env) {
      const others = container.env.filter((e) => e.name !== field.name);
      expect(() => verify(others)).toThrow();
      expect(() => verify([...others, { name: field.name, value: "fake" }])).toThrow();
      expect(() => verify([...container.env, field])).toThrow();
    }
  });

  it("admits another run only inside the VM's environment and deployment", () => {
    const verify = (input = caller, vm = runner) =>
      trustedSecretProxyIdentity(vm, pod, input, "node-1", "runners");
    expect(verify()).toMatchObject({
      bootstrapRunId: "run_bootstrap",
      publishedGuestId: "guest-1",
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
