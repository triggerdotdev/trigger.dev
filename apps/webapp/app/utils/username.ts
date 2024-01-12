import type { User as DBUser } from "~/models/user.server";

type User = Pick<DBUser, "name" | "displayName">;

// remove `null` from username
export function getUsername(user?: User): string | undefined {
  if (!user) {
    return;
  }

  // user.displayName is of type `string | null`
  if (user.displayName) {
    return user.displayName;
  }

  // user.name is of type `string | null`
  if (user.name) {
    return user.name;
  }

  return;
}
