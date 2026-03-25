import type { Authenticator } from "remix-auth";
import { GoogleStrategy } from "remix-auth-google";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { postAuthentication } from "./postAuth.server";

export function addGoogleStrategy(
  authenticator: Authenticator<AuthUser>,
  clientID: string,
  clientSecret: string
) {
  const googleStrategy = new GoogleStrategy(
    {
      clientID,
      clientSecret,
      callbackURL: `${env.LOGIN_ORIGIN}/auth/google/callback`,
    },
    async ({ extraParams, profile }) => {
      const emails = profile.emails;

      if (!emails?.length) {
        throw new Error("Google login requires an email address");
      }

      try {
        logger.debug("Google login", {
          emails,
          profile,
          extraParams,
        });

        const { user, isNewUser } = await findOrCreateUser({
          email: emails[0].value,
          authenticationMethod: "GOOGLE",
          authenticationProfile: profile,
          authenticationExtraParams: extraParams,
        });

        await postAuthentication({ user, isNewUser, loginMethod: "GOOGLE" });

        return {
          userId: user.id,
        };
      } catch (error) {
        logger.error("Google login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(googleStrategy);
}
