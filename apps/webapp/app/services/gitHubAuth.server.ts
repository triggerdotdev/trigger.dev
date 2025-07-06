import type { Authenticator } from "remix-auth";
import { GitHubStrategy } from "remix-auth-github";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { postAuthentication } from "./postAuth.server";
import { logger } from "./logger.server";
import { MfaRequiredError } from "./mfa/multiFactorAuthentication.server";

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

        // Check if user has MFA enabled
        if (user.mfaEnabledAt) {
          // Throw a special error that will be caught by the callback route
          throw new MfaRequiredError(user.id);
        }

        return {
          userId: user.id,
        };
      } catch (error) {
        // Skip logging the error if it's a MfaRequiredError
        if (error instanceof MfaRequiredError) {
          throw error;
        }

        console.error(error);
        throw error;
      }
    }
  );

  authenticator.use(gitHubStrategy);
}
