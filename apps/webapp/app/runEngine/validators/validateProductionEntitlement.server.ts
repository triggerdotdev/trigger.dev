import type { EntitlementResult } from "~/services/billingLimit.schemas";
import { OutOfEntitlementError } from "~/v3/outOfEntitlementError.server";
import type { EntitlementValidationParams, EntitlementValidationResult } from "../types";

export type GetEntitlementFn = (organizationId: string) => Promise<EntitlementResult | undefined>;

export async function validateProductionEntitlement(
  params: EntitlementValidationParams,
  getEntitlementFn: GetEntitlementFn
): Promise<EntitlementValidationResult> {
  const { environment } = params;

  if (environment.type === "DEVELOPMENT") {
    return { ok: true };
  }

  const result = await getEntitlementFn(environment.organizationId);

  if (result && result.hasAccess === false) {
    return {
      ok: false,
      error: new OutOfEntitlementError(),
    };
  }

  return { ok: true, plan: result?.plan };
}
