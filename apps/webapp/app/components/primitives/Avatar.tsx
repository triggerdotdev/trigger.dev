import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import {
  BoltIcon,
  BuildingOffice2Icon,
  CodeBracketSquareIcon,
  FaceSmileIcon,
  FireIcon,
  RocketLaunchIcon,
  StarIcon,
} from "@heroicons/react/20/solid";
import type { Prisma } from "@trigger.dev/database";
import { useCallback, useState } from "react";
import { z } from "zod";
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
    hex: z.string(),
  }),
  z.object({
    type: z.literal(AvatarType.enum.image),
    url: z.string(),
    lastIconHex: z.string().optional(),
  }),
]);

export type Avatar = z.infer<typeof AvatarData>;
export type IconAvatar = Extract<Avatar, { type: "icon" }>;
type ImageAvatar = Extract<Avatar, { type: "image" }>;
type LettersAvatar = Extract<Avatar, { type: "letters" }>;

export function parseAvatar(json: Prisma.JsonValue, defaultAvatar: Avatar): Avatar {
  if (!json || typeof json !== "object") {
    return defaultAvatar;
  }

  const parsed = AvatarData.safeParse(json);

  if (!parsed.success) {
    console.error("Invalid org avatar", { json, error: parsed.error });
    return defaultAvatar;
  }

  return parsed.data;
}

export function Avatar({
  avatar,
  size,
  includePadding,
  orgName,
}: {
  avatar: Avatar;
  /** Size in rems of the icon */
  size: number;
  includePadding?: boolean;
  orgName: string;
}) {
  switch (avatar.type) {
    case "icon":
      return <AvatarIcon avatar={avatar} size={size} includePadding={includePadding} />;
    case "letters":
      return (
        <AvatarLetters
          avatar={avatar}
          size={size}
          includePadding={includePadding}
          orgName={orgName}
        />
      );
    case "image":
      return <AvatarImage key={avatar.url} avatar={avatar} size={size} />;
  }
}

export const avatarIcons: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  "hero:building-office-2": BuildingOffice2Icon,
  "hero:rocket-launch": RocketLaunchIcon,
  "hero:code-bracket-square": CodeBracketSquareIcon,
  "hero:fire": FireIcon,
  "hero:star": StarIcon,
  "hero:face-smile": FaceSmileIcon,
  "hero:bolt": BoltIcon,
};

export const defaultAvatarColors = [
  { hex: "#878C99", name: "Gray" },
  { hex: "#713F12", name: "Brown" },
  { hex: "#F97316", name: "Orange" },
  { hex: "#EAB308", name: "Yellow" },
  { hex: "#22C55E", name: "Green" },
  { hex: "#3B82F6", name: "Blue" },
  { hex: "#6366F1", name: "Purple" },
  { hex: "#EC4899", name: "Pink" },
  { hex: "#F43F5E", name: "Red" },
];

// purple
export const defaultAvatarHex = defaultAvatarColors[6].hex;

export const defaultAvatar: Avatar = {
  type: "letters",
  hex: defaultAvatarHex,
};

function styleFromSize(size: number) {
  return {
    width: `${size}rem`,
    height: `${size}rem`,
  };
}

// Bright tiles (Yellow, Orange) need dark letters for contrast; the rest read
// best with white.
function letterColorForBackground(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#fff";
  const n = parseInt(match[1], 16);
  const luminance = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luminance > 140 ? "#272A2E" : "#fff";
}

function AvatarLetters({
  avatar,
  size,
  includePadding,
  orgName,
}: {
  avatar: LettersAvatar;
  size: number;
  includePadding?: boolean;
  orgName: string;
}) {
  const letters = orgName.slice(0, 2);

  const style = {
    backgroundColor: avatar.hex,
    color: letterColorForBackground(avatar.hex),
  };

  const scaleFactor = includePadding ? 0.8 : 1;

  return (
    <span className="grid shrink-0 place-items-center overflow-hidden" style={styleFromSize(size)}>
      {/* This is the square container */}
      <span
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-[10%] font-semibold",
          includePadding ? "size-[80%]" : "size-full"
        )}
        style={style}
      >
        <span
          className="font-bold leading-none"
          style={{ fontSize: `${size * 0.6 * scaleFactor}rem` }}
        >
          {letters}
        </span>
      </span>
    </span>
  );
}

function AvatarIcon({
  avatar,
  size,
  includePadding,
}: {
  avatar: IconAvatar;
  size: number;
  includePadding?: boolean;
}) {
  const style = {
    color: avatar.hex,
  };

  const IconComponent = avatarIcons[avatar.name];
  return (
    <span className="grid aspect-square place-items-center" style={styleFromSize(size)}>
      <IconComponent className={includePadding ? "size-[80%]" : "size-full"} style={style} />
    </span>
  );
}

function AvatarImage({ avatar, size }: { avatar: ImageAvatar; size: number }) {
  const [failed, setFailed] = useState(false);

  // A server-rendered image can finish failing before hydration, so onError never fires.
  const detectFailedLoad = useCallback((node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth === 0) {
      setFailed(true);
    }
  }, []);

  if (!avatar.url || failed) {
    return (
      <span
        role="img"
        aria-label="Organization avatar"
        className="grid shrink-0 place-items-center overflow-hidden"
        style={styleFromSize(size)}
      >
        <GlobeLinesIcon className="size-[90%] text-text-dimmed" />
      </span>
    );
  }

  return (
    <span className="grid shrink-0 place-items-center overflow-hidden" style={styleFromSize(size)}>
      <img
        ref={detectFailedLoad}
        src={avatar.url}
        alt="Organization avatar"
        className="size-full rounded-[10%] object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
