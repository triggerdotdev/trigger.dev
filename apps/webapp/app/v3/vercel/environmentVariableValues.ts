import type { ResponseBodyEnvs } from "@vercel/sdk/models/filterprojectenvsop";
import type { VercelEnvironmentVariableValue } from "~/models/vercelIntegration.server";

export function normalizeTarget(target: string[] | string | undefined): string[] {
  if (Array.isArray(target)) return target.filter(Boolean);
  if (typeof target === "string") return [target];
  return [];
}

export function isVercelSecretType(type: string): boolean {
  return type === "secret" || type === "sensitive";
}

export function toVercelEnvironmentVariableValue(
  env: ResponseBodyEnvs,
  allowEmptyValues = true
): VercelEnvironmentVariableValue | null {
  if (
    env.value === undefined ||
    env.value === null ||
    (!allowEmptyValues && env.value.trim() === "")
  )
    return null;
  return {
    key: env.key,
    value: env.value,
    target: normalizeTarget(env.target),
    type: env.type,
    isSecret: isVercelSecretType(env.type),
  };
}

/** Enabled inline values are authoritative; disabled blank values allow a fetched fallback. */
export async function resolveVercelSharedValue(
  inlineValue: string | null | undefined,
  fetchValue: () => Promise<string | null>,
  allowEmptyValues = true
): Promise<string | null> {
  if (
    inlineValue !== undefined &&
    inlineValue !== null &&
    (allowEmptyValues || inlineValue.trim() !== "")
  ) {
    return inlineValue;
  }
  const value = await fetchValue();
  return !allowEmptyValues && value !== null && value.trim() === "" ? null : value;
}

/** A project key takes precedence even when its value is empty. */
export function mergeVercelEnvironmentVariableValues<
  Project extends { key: string },
  Shared extends { key: string },
>(project: Project[], shared: Shared[]): Array<Project | Shared> {
  const projectKeys = new Set(project.map((variable) => variable.key));
  return [...project, ...shared.filter((variable) => !projectKeys.has(variable.key))];
}
