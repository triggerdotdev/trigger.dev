import type { Authenticator } from "remix-auth";
import { GitHubStrategy } from "remix-auth-github";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { postAuthentication } from "./postAuth.server";

export function addGitHubStrategy(
  authenticator: Authenticator<AuthUser>,
  clientID: string,
  clientSecret: string
) {
  const gitHubStrategy = new GitHubStrategy(
    {
      clientID,
      clientSecret,
      callbackURL: `${env.LOGIN_ORIGIN}/auth/github/callback`,
    },
    async ({ extraParams, profile }) => {
      const emails = profile.emails;

      if (!emails) {
        throw new Error("GitHub login requires an email address");
      }

      try {
        logger.debug("GitHub login", {
          emails,
          profile,
          extraParams,
        });

        const { user, isNewUser } = await findOrCreateUser({
          email: emails[0].value,
          authenticationMethod: "GITHUB",
          authenticationProfile: profile,
          authenticationExtraParams: extraParams,
        });

        await postAuthentication({ user, isNewUser, loginMethod: "GITHUB" });

        return {
          userId: user.id,
        };
      } catch (error) {
        logger.error("GitHub login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(gitHubStrategy);
}
