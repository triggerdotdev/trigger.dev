import type { User } from "~/models/user.server";
import { analytics } from "./analytics.server";

export async function postAuthentication({
  user,
  loginMethod,
  isNewUser,
}: {
  user: User;
  loginMethod: User["authenticationMethod"];
  isNewUser: boolean;
}) {
  analytics.user.identify({ user, isNewUser });
}
