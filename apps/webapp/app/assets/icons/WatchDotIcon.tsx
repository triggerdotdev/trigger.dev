import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) variant of the Watch action's eye icon (heroicons
// `EyeIcon`), for comparison in storybook.ai-agent. 8x8 grid: an almond outline with a
// 2x2 pupil block. Not used anywhere in the app.
const BITMAP = [
  "........",
  "..oooo..",
  ".o....o.",
  "o..oo..o",
  "o..oo..o",
  ".o....o.",
  "..oooo..",
  "........",
];

export function WatchDotIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <DotMatrixIcon bitmap={BITMAP} className={className} style={style} />;
}
