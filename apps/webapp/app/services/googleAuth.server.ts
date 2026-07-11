import type { Authenticator } from "remix-auth";
import { GoogleStrategy } from "remix-auth-google";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { isGoogleEmailVerified } from "./googleEmailVerification";
import { logger } from "./logger.server";
import { postAuthentication } from "./postAuth.server";
import { SsoRequiredError, ssoRedirectForEmail } from "./ssoAutoDiscovery.server";

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

      const email = emails[0].value;

      // Only trust the email if Google asserts it's verified, since account
      // linking keys off it. See isGoogleEmailVerified.
      if (!isGoogleEmailVerified(profile)) {
        throw new Error(
          "Google login refused: the Google account's email is not verified. Sign in with an account whose email Google has verified, or use magic-link / GitHub."
        );
      }

      // SSO auto-discovery gate — BEFORE findOrCreateUser, so an
      // SSO-enforced domain never gets this Google identity linked onto
      // an existing account.
      const ssoRedirect = await ssoRedirectForEmail(email, "oauth_blocked");
      if (ssoRedirect) {
        throw new SsoRequiredError(ssoRedirect);
      }

      try {
        logger.debug("Google login", {
          emails,
          profile,
          extraParams,
        });

        const { user, isNewUser } = await findOrCreateUser({
          email,
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
