import { BillingLimitBulkCancelService } from "./BillingLimitBulkCancelService.server";

export async function runBillingLimitCancelInProgressRuns(
  organizationId: string,
  hitAt: string
): Promise<{ bulkActionIds: string[] }> {
  return BillingLimitBulkCancelService.cancelInProgressRuns(organizationId, { hitAt });
}
