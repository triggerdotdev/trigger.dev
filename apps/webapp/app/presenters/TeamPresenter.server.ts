import { getTeamMembersAndInvites } from "~/models/member.server";
import { getCurrentPlan, getLimit, getPlans } from "~/services/platform.v3.server";
import { BasePresenter } from "./v3/basePresenter.server";

export class TeamPresenter extends BasePresenter {
  public async call({ userId, organizationId }: { userId: string; organizationId: string }) {
    const result = await getTeamMembersAndInvites({
      userId,
      organizationId,
    });

    if (!result) {
      return;
    }

    const [baseLimit, currentPlan, plans] = await Promise.all([
      getLimit(organizationId, "teamMembers", 100_000_000),
      getCurrentPlan(organizationId),
      getPlans(),
    ]);

    const canPurchaseSeats =
      currentPlan?.v3Subscription?.plan?.limits.teamMembers.canExceed === true;
    const extraSeats = currentPlan?.v3Subscription?.addOns?.seats?.purchased ?? 0;
    const maxSeatQuota = currentPlan?.v3Subscription?.addOns?.seats?.quota ?? 0;
    const planSeatLimit = currentPlan?.v3Subscription?.plan?.limits.teamMembers.number ?? 0;
    const seatPricing = plans?.addOnPricing.seats ?? null;
    const limit = baseLimit + extraSeats;

    return {
      ...result,
      limits: {
        used: result.members.length + result.invites.length,
        limit,
      },
      canPurchaseSeats,
      extraSeats,
      seatPricing,
      maxSeatQuota,
      planSeatLimit,
    };
  }
}
