import type { User } from "~/models/user.server";
import { telemetry } from "./telemetry.server";

export async function postAuthentication({
  user,
  loginMethod,
  isNewUser,
}: {
  user: User;
  loginMethod: User["authenticationMethod"];
  isNewUser: boolean;
}) {
  telemetry.user.identify({
    user,
    isNewUser,
  });
}
