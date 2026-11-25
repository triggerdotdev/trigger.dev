import type { ReactNode, SVGProps } from "react";
import { icons, type LucideIcon } from "lucide-react";
import { withBase } from "@/lib/base-path";

// Mintlify takes Font Awesome names. Names Lucide shares map by PascalCase; the rest are aliased
// here to the closest Lucide icon, and brands are inline SVGs (Lucide 1.x dropped brand icons).
const aliases: Record<string, keyof typeof icons> = {
  "layer-group": "Layers",
  "wand-magic-sparkles": "WandSparkles",
  "message-bot": "Bot",
  robot: "Bot",
  browser: "AppWindow",
  "wave-pulse": "Activity",
  "rectangle-history": "GalleryVerticalEnd",
  "puzzle-piece": "Puzzle",
  filter: "Funnel",
  "diagram-project": "Network",
  "diagram-subtask": "Workflow",
  "screwdriver-wrench": "Wrench",
  "file-lines": "FileText",
  compress: "Shrink",
  books: "Library",
  "trash-can": "Trash",
  "tower-broadcast": "RadioTower",
  "spinner-third": "LoaderCircle",
  snake: "Code",
  "shield-halved": "Shield",
  "scale-balanced": "Scale",
  "rectangle-list": "List",
  "pen-to-square": "SquarePen",
  "pen-nib": "PenTool",
  microphone: "Mic",
  "message-lines": "MessageSquareText",
  "magnifying-glass-chart": "ChartSpline",
  "magnifying-glass": "Search",
  fire: "Flame",
  "file-csv": "FileSpreadsheet",
  docker: "Container",
  dharmachakra: "Ship",
  comments: "MessagesSquare",
  "cloud-arrow-up": "CloudUpload",
  "clock-rotate-left": "RotateCcwClock",
  "circle-xmark": "CircleX",
  "circle-question": "CircleQuestionMark",
  "bullseye-pointer": "MousePointerClick",
  bullhorn: "Megaphone",
  aws: "Cloud",
  "arrows-rotate": "RefreshCw",
  "alarm-exclamation": "AlarmClock",
  react: "Atom",
  "book-open": "BookOpen",
  code: "Code",
};

const brand = (d: string) =>
  function Brand(props: SVGProps<SVGSVGElement> & { size?: number }) {
    const { size = 16, ...rest } = props;
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden {...rest}>
        <path d={d} />
      </svg>
    );
  };

const brands: Record<string, ReturnType<typeof brand>> = {
  github: brand(
    "M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
  ),
  discord: brand(
    "M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.5 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4a13 13 0 0 1-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7M8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4m8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4"
  ),
  slack: brand(
    "M5 15.2a2.5 2.5 0 1 1-2.5-2.5H5zm1.3 0a2.5 2.5 0 0 1 5 0v6.3a2.5 2.5 0 1 1-5 0zM8.8 5a2.5 2.5 0 1 1 2.5-2.5V5zm0 1.3a2.5 2.5 0 0 1 0 5H2.5a2.5 2.5 0 0 1 0-5zM19 8.8a2.5 2.5 0 1 1 2.5 2.5H19zm-1.3 0a2.5 2.5 0 0 1-5 0V2.5a2.5 2.5 0 1 1 5 0zM15.2 19a2.5 2.5 0 1 1-2.5 2.5V19zm0-1.3a2.5 2.5 0 0 1 0-5h6.3a2.5 2.5 0 1 1 0 5z"
  ),
};

const pascal = (name: string) =>
  name
    .replace(/^fa[srlbd]?-/, "")
    .split(/[-_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");

function resolveIcon(name: string): LucideIcon | ReturnType<typeof brand> | undefined {
  const key = name.replace(/^fa[srlbd]?-/, "").toLowerCase();
  if (brands[key]) return brands[key];
  const alias = aliases[key];
  return alias ? icons[alias] : icons[pascal(name) as keyof typeof icons];
}

export function Icon({
  icon,
  size = 16,
  color,
  className = "inline",
}: {
  icon?: ReactNode;
  size?: number;
  color?: string;
  iconType?: string;
  className?: string;
}) {
  if (!icon) return null;
  if (typeof icon !== "string") return <>{icon}</>; // inline <svg> etc.
  if (icon.startsWith("/") || icon.startsWith("http"))
    return <img src={withBase(icon)} alt="" width={size} height={size} className={className} />;
  // "circle-2" etc. are numbered markers; Lucide has no digit circles.
  const digit = /^(?:fa[srlbd]?-)?circle-(\d)$/.exec(icon)?.[1];
  if (digit)
    return (
      <span
        className={`${className} inline-flex items-center justify-center rounded-full border border-current font-semibold leading-none`}
        style={{ width: size, height: size, fontSize: size * 0.6 }}
      >
        {digit}
      </span>
    );
  const Cmp = resolveIcon(icon);
  if (Cmp) return <Cmp size={size} color={color} className={className} aria-hidden />;
  // Single letters ("N", "R") are used as monograms on a few cards.
  if (icon.length <= 2)
    return (
      <span className={`${className} font-semibold leading-none`} style={{ fontSize: size * 0.9 }}>
        {icon}
      </span>
    );
  return null;
}
