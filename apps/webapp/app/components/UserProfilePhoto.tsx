import { UserCircleIcon } from "@heroicons/react/24/solid";
import { useOptionalUser } from "~/hooks/useUser";
import { cn } from "~/utils/cn";

export function UserProfilePhoto({ className }: { className?: string }) {
  const user = useOptionalUser();

  return user?.avatarUrl ? (
    <img
      className={cn("aspect-square rounded-full", className)}
      src={user.avatarUrl}
      alt={user.name ?? user.displayName ?? "User"}
    />
  ) : (
    <UserCircleIcon className={cn("aspect-square text-slate-400", className)} />
  );
}
