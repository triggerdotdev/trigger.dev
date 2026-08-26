import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix variant of the Watch action's eye icon (heroicons `EyeIcon`), drawn on the
// same 5x5 grid as the Shape library: an outline ring with a pupil dot at center. For
// comparison in storybook.ai-agent; not used anywhere in the app.
const BITMAP = [".....", ".ooo.", "o.o.o", ".ooo.", "....."];

export function WatchDotIcon({
  className,
  style,
  showGrid,
}: {
  className?: string;
  style?: React.CSSProperties;
  showGrid?: boolean;
}) {
  return <DotMatrixIcon bitmap={BITMAP} className={className} style={style} showGrid={showGrid} />;
}
