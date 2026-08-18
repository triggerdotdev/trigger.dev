import type { k8s } from "../clients/kubernetes.js";

/**
 * An empty label is the documented off-switch, leaving the pod unpinned. The Helm
 * chart ships an empty value, so don't collapse this into a fallback default -
 * that would pin every chart install to a label its nodes don't carry.
 */
export function nodetypeNodeSelector(
  label: string | undefined
): Pick<k8s.V1PodSpec, "nodeSelector"> {
  return label ? { nodeSelector: { nodetype: label } } : {};
}

/**
 * Tolerations for a run pod: the cluster-wide set, plus the scheduled-run set when the
 * run came from a schedule tree, plus the org's own set when a placement override
 * matches. Not reconciled - Kubernetes matches tolerations as an any-match set, so a
 * broad entry in one set can subsume a narrower one in another.
 * Returns undefined rather than an empty array to leave the field unset.
 */
export function runPodTolerations(
  runnerTolerations: k8s.V1Toleration[] | undefined,
  scheduledRunTolerations: k8s.V1Toleration[] | undefined,
  isScheduledRun: boolean,
  orgTolerations?: k8s.V1Toleration[]
): k8s.V1Toleration[] | undefined {
  const tolerations = [
    ...(runnerTolerations ?? []),
    ...(isScheduledRun ? (scheduledRunTolerations ?? []) : []),
    ...(orgTolerations ?? []),
  ];

  return tolerations.length > 0 ? tolerations : undefined;
}

/**
 * Merges extra node selector entries into a pod spec. Later entries win on key
 * collision, so an override can retarget a key set by an earlier stage.
 */
export function withNodeSelector(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  nodeSelector: Record<string, string> | undefined
): Omit<k8s.V1PodSpec, "containers"> {
  if (!nodeSelector || Object.keys(nodeSelector).length === 0) {
    return podSpec;
  }

  return {
    ...podSpec,
    nodeSelector: {
      ...podSpec.nodeSelector,
      ...nodeSelector,
    },
  };
}

/**
 * Applies the runner seccomp profile. The profile is a node-local file installed
 * outside this repo, so an empty path leaves the pod on the runtime default -
 * pointing at a profile the nodes don't have fails pod creation.
 */
export function withRunnerSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  profilePath: string | undefined
): Omit<k8s.V1PodSpec, "containers"> {
  if (!profilePath) {
    return podSpec;
  }

  return {
    ...podSpec,
    securityContext: {
      ...podSpec.securityContext,
      seccompProfile: {
        type: "Localhost",
        localhostProfile: profilePath,
      },
    },
  };
}
