// Non-secret fields for logging a Slack integration secret: presence booleans
// and scope arrays only, never the token values. Dependency-free so it's
// unit-tested directly.
export type SlackSecretLike = {
  botAccessToken?: string;
  userAccessToken?: string;
  refreshToken?: string;
  botScopes?: string[];
  userScopes?: string[];
};

export function slackSecretLogFields(friendlyId: string, secret: SlackSecretLike) {
  return {
    friendlyId,
    hasUserToken: !!secret.userAccessToken,
    hasRefreshToken: !!secret.refreshToken,
    botScopes: secret.botScopes,
    userScopes: secret.userScopes,
  };
}
