import { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { addEmailLinkStrategy } from "./emailAuth.server";
import { addGitHubStrategy } from "./gitHubAuth.server";
import { addGoogleStrategy } from "./googleAuth.server";
import { sessionStorage } from "./sessionStorage.server";
import { env } from "~/env.server";

// Create an instance of the authenticator, pass a generic with what
// strategies will return and will store in the session
const authenticator = new Authenticator<AuthUser>(sessionStorage);

const isGithubAuthSupported =
  typeof env.AUTH_GITHUB_CLIENT_ID === "string" &&
  typeof env.AUTH_GITHUB_CLIENT_SECRET === "string";

const isGoogleAuthSupported =
  typeof env.AUTH_GOOGLE_CLIENT_ID === "string" &&
  typeof env.AUTH_GOOGLE_CLIENT_SECRET === "string";

if (env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET) {
  addGitHubStrategy(authenticator, env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET);
}

if (env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET) {
  addGoogleStrategy(authenticator, env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET);
}

addEmailLinkStrategy(authenticator);

export { authenticator, isGithubAuthSupported, isGoogleAuthSupported };
