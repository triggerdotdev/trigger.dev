import type { k8s } from "../clients/kubernetes.js";

/**
 * Path (relative to the kubelet seccomp root, /var/lib/kubelet/seccomp) of the
 * targeted seccomp profile that blocks only io_uring_setup/enter/register and
 * allows every other syscall. Must match the profile distributed to worker nodes
 * by the infra kubeadm config.
 */
export const BLOCK_IO_URING_SECCOMP_PROFILE = "profiles/block-io-uring.json";

/**
 * Node >= 24 (libuv >= ~1.52) unconditionally creates io_uring file descriptors,
 * which cannot be checkpointed. Launching those pods under a seccomp profile that
 * fails io_uring_setup makes libuv fall back to epoll, keeping the pod
 * checkpointable. "node" (21.x), "node-22" (UV_USE_IO_URING=0 still works) and
 * "bun" do not create these descriptors, so the profile is scoped to node-24+ to
 * avoid changing the syscall surface of existing runtimes.
 *
 * Tolerant of an "experimental-" prefix in case a non-normalized value reaches here.
 */
export function runtimeRequiresSeccompProfile(runtime: string | null | undefined): boolean {
  if (!runtime) return false;
  const match = /^(?:experimental-)?node-(\d+)$/.exec(runtime);
  return match ? Number(match[1]) >= 24 : false;
}

/**
 * Applies the targeted Localhost profile that blocks only io_uring, preserving any
 * existing security-context fields. Unlike RuntimeDefault this restricts no other
 * syscalls, so it cannot break unrelated workloads (browsers, sandboxes, native
 * threads). Only call this for runtimes where runtimeRequiresSeccompProfile is true.
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
