import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) variant of the Investigate action's magnifying-glass icon
// (heroicons `MagnifyingGlassIcon`), for comparison in storybook.ai-agent's shape
// library. 10x10, generated from a true circular annulus (not hand-drawn corners) so
// the ring reads round rather than stair-stepped; "s" softens the band's inner/outer
// edge. Not used anywhere in the app.
const BITMAP = [
  "...s......",
  ".sosso....",
  ".o....o...",
  "ss....o...",
  ".s....o...",
  ".o...ss...",
  "..ooos....",
  ".......o..",
  "........o.",
  ".........o",
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
