export function isPaidAddOnPurchase(action: string): boolean {
  return action === "purchase";
}

/**
 * Allocating purchased concurrency consumes the org-wide unallocated pool and changes live
 * environment limits, so it is gated by the same manage-billing permission as a purchase.
 */
export function requiresManageBilling(action: string): boolean {
  return isPaidAddOnPurchase(action) || action === "allocate";
}
