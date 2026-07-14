import type { k8s } from "../clients/kubernetes.js";

/**
 * Node >= 24 (libuv >= ~1.52) unconditionally creates io_uring file descriptors,
 * which cannot be checkpointed. Launching those pods under the RuntimeDefault
 * seccomp profile makes io_uring_setup fail so libuv falls back to epoll, keeping
 * the pod checkpointable. "node" (21.x), "node-22" (UV_USE_IO_URING=0 still works)
 * and "bun" do not create these descriptors, so the profile is scoped to node-24+
 * to avoid changing the syscall surface of existing runtimes.
 *
 * Tolerant of an "experimental-" prefix in case a non-normalized value reaches here.
 */
export function runtimeRequiresSeccompProfile(runtime: string | null | undefined): boolean {
  if (!runtime) return false;
  const match = /^(?:experimental-)?node-(\d+)$/.exec(runtime);
  return match ? Number(match[1]) >= 24 : false;
}

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
