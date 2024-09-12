import { getTeamMembersAndInvites } from "~/models/member.server";
import { getLimit } from "~/services/platform.v3.server";
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

    const limit = await getLimit(organizationId, "teamMembers", 100_000_000);

    return {
      ...result,
      limits: {
        used: result.members.length + result.invites.length,
        limit,
      },
    };
  }
}
