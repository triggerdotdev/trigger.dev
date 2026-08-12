import type { k8s } from "../clients/kubernetes.js";

/**
 * Relative path (kubelet seccomp root) of the profile blocking only io_uring
 * syscalls. Must match the profile deployed to worker nodes.
 */
export const BLOCK_IO_URING_SECCOMP_PROFILE = "profiles/block-io-uring.json";

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
 * run came from a schedule tree. Not reconciled - Kubernetes matches tolerations as an
 * any-match set, so a broad entry in one set can subsume a narrower one in the other.
 * Returns undefined rather than an empty array to leave the field unset.
 */
export function runPodTolerations(
  runnerTolerations: k8s.V1Toleration[] | undefined,
  scheduledRunTolerations: k8s.V1Toleration[] | undefined,
  isScheduledRun: boolean
): k8s.V1Toleration[] | undefined {
  const tolerations = [
    ...(runnerTolerations ?? []),
    ...(isScheduledRun ? (scheduledRunTolerations ?? []) : []),
  ];

  return tolerations.length > 0 ? tolerations : undefined;
}

/**
 * Node >= 24 always creates io_uring fds, which can't be checkpointed. Blocking
 * io_uring_setup makes libuv fall back to epoll. Other runtimes don't need this,
 * so the profile is only applied for node-24+. Tolerates an "experimental-" prefix.
 */
export function withBlockIoUringSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  runtime: string | null | undefined
): Omit<k8s.V1PodSpec, "containers"> {
  const match = runtime ? /^(?:experimental-)?node-(\d+)$/.exec(runtime) : null;
  if (!match || Number(match[1]) < 24) {
    return podSpec;
  }

  return {
    ...podSpec,
    securityContext: {
      ...podSpec.securityContext,
      seccompProfile: {
        type: "Localhost",
        localhostProfile: BLOCK_IO_URING_SECCOMP_PROFILE,
      },
    },
  };
}
