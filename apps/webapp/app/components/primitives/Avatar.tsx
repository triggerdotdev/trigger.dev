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
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { useOrganization } from "~/hooks/useOrganizations";
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
    hex: z.string(),
  }),
  z.object({
    type: z.literal(AvatarType.enum.image),
    url: z.string().url(),
  }),
]);

export type Avatar = z.infer<typeof AvatarData>;
export type IconAvatar = Extract<Avatar, { type: "icon" }>;
export type ImageAvatar = Extract<Avatar, { type: "image" }>;
export type LettersAvatar = Extract<Avatar, { type: "letters" }>;

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
    case "letters":
      return (
        <AvatarLetters avatar={avatar} className={className} includePadding={includePadding} />
      );
    case "image":
      return <AvatarImage avatar={avatar} className={className} />;
  }
}

export const avatarIcons: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  "hero:building-office-2": BuildingOffice2Icon,
  "hero:rocket-launch": RocketLaunchIcon,
  "hero:code-bracket-square": CodeBracketSquareIcon,
  "hero:fire": FireIcon,
  "hero:star": StarIcon,
  "hero:face-smile": FaceSmileIcon,
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

function AvatarLetters({
  avatar,
  className,
  includePadding,
}: {
  avatar: LettersAvatar;
  className?: string;
  includePadding?: boolean;
}) {
  const organization = useOrganization();
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState("1rem");

  useLayoutEffect(() => {
    if (containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      // Set font size to 60% of container width (adjust as needed)
      setFontSize(`${containerWidth * 0.6}px`);
    }

    // Optional: Create a ResizeObserver for dynamic resizing
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.current) {
          const containerWidth = entry.contentRect.width;
          setFontSize(`${containerWidth * 0.6}px`);
        }
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const letters = organization.title.slice(0, 2);

  const classes = cn("grid place-items-center", className);
  const style = {
    backgroundColor: avatar.hex,
  };

  return (
    <span className={cn("grid place-items-center overflow-hidden text-charcoal-750", classes)}>
      {/* This is the square container */}
      <span
        ref={containerRef}
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-[10%] font-semibold",
          includePadding ? "size-[80%]" : "size-[100%]"
        )}
        style={style}
      >
        <span ref={textRef} className="font-bold leading-none" style={{ fontSize }}>
          {letters}
        </span>
      </span>
    </span>
  );
}

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

  const IconComponent = avatarIcons[avatar.name];
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
