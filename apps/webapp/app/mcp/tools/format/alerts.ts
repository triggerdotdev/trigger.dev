import { fenceUntrusted } from "../../gate/fence.server";

type AlertCapabilityParam = {
  key: string;
  label: string;
  unit?: string;
  default: number;
  min?: number;
  max?: number;
};

export type AlertCapability = {
  key: string;
  title: string;
  unit?: string;
  area: string;
  allowedKinds: string[];
  allowedScopes: string[];
  params?: AlertCapabilityParam[];
};

export function formatCapabilityLine(capability: AlertCapability): string {
  const unit = capability.unit ? ` (${capability.unit})` : "";
  const params = capability.params?.length
    ? ` — params: ${capability.params
        .map((param) => {
          const paramUnit = param.unit ? ` ${param.unit}` : "";
          const range =
            param.min !== undefined || param.max !== undefined
              ? ` [${param.min ?? "-"}, ${param.max ?? "-"}]`
              : "";
          return `${param.key} (${param.label}, default=${param.default}${paramUnit}${range})`;
        })
        .join(", ")}`
    : "";
  return `- ${capability.key}: ${capability.title}${unit} — area=${capability.area}, kinds=${capability.allowedKinds.join(", ")}, scopes=${capability.allowedScopes.join(", ")}${params}`;
}

export function formatAlertLine(alert: {
  id: string;
  name: string | null;
  capabilityKey: string;
  lifecycle: string;
  attention: string;
}): string {
  const name = alert.name ? fenceUntrusted(alert.name, "alert-name") : "(unnamed)";
  return `- ${name} (id=${alert.id}) capability=${alert.capabilityKey} lifecycle=${alert.lifecycle} attention=${alert.attention}`;
}
