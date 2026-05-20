import { getTeamMembersAndInvites } from "~/models/member.server";
import { rbac } from "~/services/rbac.server";
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

    const [baseLimit, currentPlan, plans, roles, assignableRoleIds, memberRoleMap] =
      await Promise.all([
        getLimit(organizationId, "teamMembers", 100_000_000),
        getCurrentPlan(organizationId),
        getPlans(),
        // RBAC role catalogue (system roles + any org-defined custom
        // roles). The default fallback returns []; an installed plugin
        // may return the seeded system roles plus any custom roles.
        rbac.allRoles(organizationId),
        // Plan-gated subset — the Teams page disables dropdown options not
        // in this set. Server-side enforcement is independent (setUserRole
        // rejects a plan-gated assignment regardless of UI state).
        rbac.getAssignableRoleIds(organizationId),
        // Per-member current role in a single round-trip.
        rbac.getUserRoles(
          result.members.map((m) => m.user.id),
          organizationId
        ),
      ]);

    const memberRoles = result.members.map((m) => ({
      userId: m.user.id,
      role: memberRoleMap.get(m.user.id) ?? null,
    }));

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
      roles,
      assignableRoleIds,
      memberRoles,
    };
  }
}
