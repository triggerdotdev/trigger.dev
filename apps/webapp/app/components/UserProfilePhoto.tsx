import { AvatarCircleIcon, AvatarCircleIconThin } from "~/assets/icons/AvatarCircleIcon";
import { useOptionalUser } from "~/hooks/useUser";
import { cn } from "~/utils/cn";

export function UserProfilePhoto({
  className,
  thin = false,
}: {
  className?: string;
  /** Use the thinner 1.5px-stroke placeholder icon (defaults to the 2px variant). */
  thin?: boolean;
}) {
  const user = useOptionalUser();
  return (
    <UserAvatar avatarUrl={user?.avatarUrl} name={user?.name} className={className} thin={thin} />
  );
}

export function UserAvatar({
  avatarUrl,
  name,
  className,
  thin = false,
}: {
  avatarUrl?: string | null;
  name?: string | null;
  className?: string;
  /** Use the thinner 1.5px-stroke placeholder icon (defaults to the 2px variant). */
  thin?: boolean;
}) {
  if (avatarUrl) {
    return (
      <div className={cn("grid aspect-square place-items-center", className)}>
        <img
          className={cn("aspect-square rounded-full p-[7%]")}
          src={avatarUrl}
          alt={name ?? "User"}
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  const PlaceholderIcon = thin ? AvatarCircleIconThin : AvatarCircleIcon;
  return <PlaceholderIcon className={cn("aspect-square text-text-dimmed", className)} />;
}
