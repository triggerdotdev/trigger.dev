import type { k8s } from "../clients/kubernetes.js";

export function withRuntimeDefaultSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">
): Omit<k8s.V1PodSpec, "containers"> {
  return {
    ...podSpec,
    securityContext: {
      ...podSpec.securityContext,
      seccompProfile: {
        type: "RuntimeDefault",
      },
    },
  };
}
