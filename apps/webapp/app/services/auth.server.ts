import { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { addEmailLinkStrategy } from "./emailAuth.server";
import { addGitHubStrategy } from "./gitHubAuth.server";
import { sessionStorage } from "./sessionStorage.server";

// Create an instance of the authenticator, pass a generic with what
// strategies will return and will store in the session
const authenticator = new Authenticator<AuthUser>(sessionStorage);

addGitHubStrategy(authenticator);
addEmailLinkStrategy(authenticator);

export { authenticator };
