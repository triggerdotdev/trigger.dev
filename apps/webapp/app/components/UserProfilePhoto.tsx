import { UserCircleIcon } from "@heroicons/react/24/solid";
import classNames from "classnames";
import type { User } from "~/models/user.server";

export function UserProfilePhoto({
  user,
  className,
}: {
  user: User;
  className?: string;
}) {
  return user.avatarUrl ? (
    <img
      className={classNames("rounded-full", className)}
      src={user.avatarUrl}
      alt={user.name ?? user.displayName ?? "User"}
    />
  ) : (
    <UserCircleIcon className={classNames("text-gray-400", className)} />
  );
}
