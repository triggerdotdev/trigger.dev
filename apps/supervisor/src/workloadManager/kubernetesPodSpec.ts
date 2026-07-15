import type { k8s } from "../clients/kubernetes.js";

/**
 * Relative path (kubelet seccomp root) of the profile blocking only io_uring
 * syscalls. Must match the profile deployed to worker nodes.
 */
export const BLOCK_IO_URING_SECCOMP_PROFILE = "profiles/block-io-uring.json";

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
