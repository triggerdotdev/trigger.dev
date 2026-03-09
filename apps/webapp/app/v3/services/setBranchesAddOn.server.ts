import { BaseService } from "./baseService.server";
import { tryCatch } from "@trigger.dev/core";
import { setBranchesAddOn } from "~/services/platform.v3.server";
import assertNever from "assert-never";
import { sendToPlain } from "~/utils/plain.server";
import { uiComponent } from "@team-plain/typescript-sdk";

type Input = {
  userId: string;
  organizationId: string;
  action: "purchase" | "quota-increase";
  amount: number;
};

type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export class SetBranchesAddOnService extends BaseService {
  async call({ userId, organizationId, action, amount }: Input): Promise<Result> {
    switch (action) {
      case "purchase": {
        const result = await setBranchesAddOn(organizationId, amount);
        if (!result) {
          return {
            success: false,
            error: "Failed to update preview branches",
          };
        }

        switch (result.result) {
          case "success": {
            return { success: true };
          }
          case "error": {
            return { success: false, error: result.error };
          }
          case "max_quota_reached": {
            return {
              success: false,
              error: `You can't purchase more than ${result.maxQuota} preview branches without requesting an increase.`,
            };
          }
          default: {
            return {
              success: false,
              error: "Failed to update preview branches, unknown result.",
            };
          }
        }
      }
      case "quota-increase": {
        const user = await this._replica.user.findFirst({
          where: { id: userId },
        });

        if (!user) {
          return { success: false, error: "No matching user found." };
        }

        const organization = await this._replica.organization.findFirst({
          select: { title: true },
          where: { id: organizationId },
        });

        const [error] = await tryCatch(
          sendToPlain({
            userId,
            email: user.email,
            name: user.name ?? user.displayName ?? user.email,
            title: `Preview branches quota request: ${amount}`,
            components: [
              uiComponent.text({
                text: `Org: ${organization?.title} (${organizationId})`,
              }),
              uiComponent.divider({ spacingSize: "M" }),
              uiComponent.text({
                text: `Total preview branches requested: ${amount}`,
              }),
            ],
          })
        );

        if (error) {
          return { success: false, error: error.message };
        }

        return { success: true };
      }
      default: {
        assertNever(action);
      }
    }
  }
}
