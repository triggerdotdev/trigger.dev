import { UserCircleIcon } from "@heroicons/react/24/solid";
import type { User } from "~/models/user.server";
import { cn } from "~/utils/cn";

export function UserProfilePhoto({
  user,
  className,
}: {
  user: User;
  className?: string;
}) {
  return user.avatarUrl ? (
    <img
      className={cn("rounded-full", className)}
      src={user.avatarUrl}
      alt={user.name ?? user.displayName ?? "User"}
    />
  ) : (
    <UserCircleIcon className={cn("text-gray-400", className)} />
  );
}
