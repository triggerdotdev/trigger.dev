import {
  AvatarCircleIcon,
  AvatarCircleIconExtraThin,
  AvatarCircleIconThin,
} from "~/assets/icons/AvatarCircleIcon";
import { useOptionalUser } from "~/hooks/useUser";
import { cn } from "~/utils/cn";

/** Stroke width (px) of the placeholder avatar icon shown when there is no photo. */
type AvatarStrokeWidth = 1.25 | 1.5 | 2;

const PLACEHOLDER_BY_STROKE_WIDTH = {
  1.25: AvatarCircleIconExtraThin,
  1.5: AvatarCircleIconThin,
  2: AvatarCircleIcon,
} as const;

export function UserProfilePhoto({
  className,
  strokeWidth = 2,
}: {
  className?: string;
  strokeWidth?: AvatarStrokeWidth;
}) {
  const user = useOptionalUser();
  return (
    <UserAvatar
      avatarUrl={user?.avatarUrl}
      name={user?.name}
      className={className}
      strokeWidth={strokeWidth}
    />
  );
}

export function UserAvatar({
  avatarUrl,
  name,
  className,
  strokeWidth = 2,
}: {
  avatarUrl?: string | null;
  name?: string | null;
  className?: string;
  strokeWidth?: AvatarStrokeWidth;
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

  const PlaceholderIcon = PLACEHOLDER_BY_STROKE_WIDTH[strokeWidth];
  return <PlaceholderIcon className={cn("aspect-square text-text-dimmed", className)} />;
}
