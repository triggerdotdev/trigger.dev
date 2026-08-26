import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) variant of the Watch action's eye icon (heroicons
// `EyeIcon`), for comparison in storybook.ai-agent's shape library. 9x9, generated from
// an elliptical band (not hand-drawn corners) so the almond outline reads round; "s"
// softens the band's inner/outer edge. Not used anywhere in the app.
const BITMAP = [
  ".........",
  ".........",
  "..sooos..",
  ".o..o..o.",
  ".o.ooo.o.",
  ".o..o..o.",
  "..sooos..",
  ".........",
  ".........",
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
