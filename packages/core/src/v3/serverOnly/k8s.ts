import { env } from "std-env";

export function isKubernetesEnvironment(override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }

  // Then check for common Kubernetes environment variables
  const k8sIndicators = [
    env.KUBERNETES_PORT,
    env.KUBERNETES_SERVICE_HOST,
    env.KUBERNETES_SERVICE_PORT,
  ];

  return k8sIndicators.some(Boolean);
}
