import type { k8s } from "../clients/kubernetes.js";

/**
 * Relative path (kubelet seccomp root) of the profile blocking only io_uring
 * syscalls. Must match the profile deployed to worker nodes.
 */
export const BLOCK_IO_URING_SECCOMP_PROFILE = "profiles/block-io-uring.json";

/**
 * Node >= 24 always creates io_uring fds, which can't be checkpointed. Blocking
 * io_uring_setup makes libuv fall back to epoll. Other runtimes don't need this,
 * so it's scoped to node-24+. Tolerates an "experimental-" prefix.
 */
export function runtimeRequiresSeccompProfile(runtime: string | null | undefined): boolean {
  if (!runtime) return false;
  const match = /^(?:experimental-)?node-(\d+)$/.exec(runtime);
  return match ? Number(match[1]) >= 24 : false;
}

/**
 * Applies the io_uring-blocking seccomp profile, preserving existing
 * security-context fields. Only call when runtimeRequiresSeccompProfile is true.
 */
export function withBlockIoUringSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">
): Omit<k8s.V1PodSpec, "containers"> {
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
