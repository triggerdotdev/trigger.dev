import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) variant of the Investigate action's magnifying-glass icon
// (heroicons `MagnifyingGlassIcon`), for comparison in storybook.ai-agent. 8x8 grid: a
// coarse ring for the lens, a 3-dot diagonal for the handle. Not used anywhere in the app.
const BITMAP = [
  ".oooo...",
  "o....o..",
  "o....o..",
  "o....o..",
  ".oooo...",
  ".....o..",
  "......o.",
  ".......o",
];

export function InvestigateDotIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <DotMatrixIcon bitmap={BITMAP} className={className} style={style} />;
}
