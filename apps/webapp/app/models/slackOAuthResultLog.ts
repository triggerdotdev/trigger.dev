// Non-secret fields for logging a Slack `oauth.v2.access` response, which
// otherwise carries bot/user/refresh tokens. Dependency-free so it's
// unit-tested directly.
export type SlackAccessResultLike = {
  team?: { id?: string } | null;
  scope?: string;
  authed_user?: { access_token?: string } | null;
  refresh_token?: string;
};

export function slackAccessResultLogFields(result: SlackAccessResultLike) {
  return {
    teamId: result.team?.id,
    scope: result.scope,
    hasUserToken: !!result.authed_user?.access_token,
    hasRefreshToken: !!result.refresh_token,
  };
}
