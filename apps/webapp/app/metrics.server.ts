import { type OpenMetricsContentType, Registry, collectDefaultMetrics, register } from "prom-client";
import { singleton } from "./utils/singleton";
import { env } from "./env.server";

export const metricsRegister = singleton("metricsRegister", initializeMetricsRegister);

function initializeMetricsRegister() {
  const registry = new Registry<OpenMetricsContentType>();

  register.setDefaultLabels({
    serviceName: env.SERVICE_NAME,
  });

  registry.setContentType("application/openmetrics-text; version=1.0.0; charset=utf-8");

  collectDefaultMetrics({ register: registry });

  return registry;
}
