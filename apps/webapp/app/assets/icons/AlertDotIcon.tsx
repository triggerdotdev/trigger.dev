import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix bell variant for the Investigate/Watch comparison set, drawn on the same
// 5x5 grid as the Shape library: knob, rounded dome sides, flared lip, clapper. For
// comparison in storybook.ai-agent; not used anywhere in the app.
const BITMAP = ["..o..", ".ooo.", "o...o", "ooooo", "..o.."];

export function AlertDotIcon({
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
