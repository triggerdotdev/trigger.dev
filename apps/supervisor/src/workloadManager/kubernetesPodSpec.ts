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

export type RunnerSeccompProfileOptions = {
  profilePath: string;
  runtimes: "none" | "node-24-plus" | "all";
  runtime: string | null | undefined;
  checkpointsEnabled: boolean | undefined;
};

/**
 * Applies the runner seccomp profile, which is a node-local file installed outside
 * this repo - pointing a pod at a profile its node doesn't have fails pod creation,
 * so every condition for skipping it lives here.
 *
 * "node-24-plus" matches the original rollout: node >= 24 always creates io_uring
 * fds, which can't be checkpointed, and blocking io_uring_setup makes libuv fall
 * back to epoll. Tolerates an "experimental-" prefix. "bun" matches only under "all".
 */
export function withRunnerSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  options: RunnerSeccompProfileOptions
): Omit<k8s.V1PodSpec, "containers"> {
  if (!options.checkpointsEnabled || options.runtimes === "none") {
    return podSpec;
  }

  if (options.runtimes === "node-24-plus") {
    const match = options.runtime ? /^(?:experimental-)?node-(\d+)$/.exec(options.runtime) : null;
    if (!match || Number(match[1]) < 24) {
      return podSpec;
    }
  }

  return {
    ...podSpec,
    securityContext: {
      ...podSpec.securityContext,
      seccompProfile: {
        type: "Localhost",
        localhostProfile: options.profilePath,
      },
    },
  };
}

const BUN_RUN_AS_USER = 1001;

/**
 * runnerSecurityContext maps a configured level onto the run container's security
 * context. "baseline" drops the capability bounding set and blocks setuid
 * escalation; "restricted" additionally pins the container to a non-root uid.
 *
 * The uid is set explicitly rather than read from the image: the kubelet cannot
 * verify `runAsNonRoot` against an image that declares a named user, and fails
 * the container instead. Bun images carry their user at a different uid to
 * node's, so the runtime selects which uid is pinned.
 */
export function runnerSecurityContext(
  level: "off" | "baseline" | "restricted",
  runAsUser: number,
  runtime: string | null | undefined
): k8s.V1SecurityContext | undefined {
  if (level === "off") {
    return undefined;
  }

  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    ...(level === "restricted"
      ? { runAsNonRoot: true, runAsUser: runtime === "bun" ? BUN_RUN_AS_USER : runAsUser }
      : {}),
  };
}
