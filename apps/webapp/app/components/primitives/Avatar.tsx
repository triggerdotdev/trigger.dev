import {
  BuildingOffice2Icon,
  CodeBracketSquareIcon,
  CubeIcon,
  FaceSmileIcon,
  FireIcon,
  RocketLaunchIcon,
  StarIcon,
} from "@heroicons/react/24/solid";
import { type Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { cn } from "~/utils/cn";

export const AvatarType = z.enum(["icon", "letters", "image"]);

export const AvatarData = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(AvatarType.enum.icon),
    name: z.string(),
    hex: z.string(),
  }),
  z.object({
    type: z.literal(AvatarType.enum.letters),
  }),
  z.object({
    type: z.literal(AvatarType.enum.image),
    url: z.string().url(),
  }),
]);

export type Avatar = z.infer<typeof AvatarData>;
export type IconAvatar = Extract<Avatar, { type: "icon" }>;
export type ImageAvatar = Extract<Avatar, { type: "image" }>;

export function parseAvatar(json: Prisma.JsonValue, defaultAvatar: Avatar): Avatar {
  if (!json || typeof json !== "object") {
    return defaultAvatar;
  }

  const parsed = AvatarData.safeParse(json);

  if (!parsed.success) {
    logger.error("Invalid org avatar", { json, error: parsed.error });
    return defaultAvatar;
  }

  return parsed.data;
}

export function Avatar({
  avatar,
  className,
  includePadding,
}: {
  avatar: Avatar;
  className?: string;
  includePadding?: boolean;
}) {
  switch (avatar.type) {
    case "icon":
      return <AvatarIcon avatar={avatar} className={className} includePadding={includePadding} />;
    case "image":
      return <AvatarImage avatar={avatar} className={className} />;
  }
}

export const avatarIcons: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  "hero:building-office-2": BuildingOffice2Icon,
  "hero:cube": CubeIcon,
  "hero:rocket-launch": RocketLaunchIcon,
  "hero:code-bracket-square": CodeBracketSquareIcon,
  "hero:fire": FireIcon,
  "hero:star": StarIcon,
  "hero:face-smile": FaceSmileIcon,
};

export const defaultAvatarColors = [
  "#2563EB",
  "#4F46E5",
  "#9333EA",
  "#DB2777",
  "#E11D48",
  "#EA580C",
  "#EAB308",
  "#16A34A",
];

export const defaultAvatarIcon: IconAvatar = {
  type: "icon",
  name: "hero:building-office-2",
  hex: defaultAvatarColors[0],
};

function AvatarIcon({
  avatar,
  className,
  includePadding,
}: {
  avatar: IconAvatar;
  className?: string;
  includePadding?: boolean;
}) {
  const classes = cn("aspect-square", className);
  const style = {
    color: avatar.hex,
  };

  const IconComponent = avatarIcons[avatar.name] || defaultAvatarIcon.name;
  return (
    <span className={cn("grid place-items-center", classes)}>
      <IconComponent className={includePadding ? "size-[80%]" : "size-[100%]"} style={style} />
    </span>
  );
}

function AvatarImage({ avatar, className }: { avatar: ImageAvatar; className?: string }) {
  return (
    <span className="grid place-items-center">
      <img src={avatar.url} alt="Organization avatar" className="size-6" />
    </span>
  );
}
