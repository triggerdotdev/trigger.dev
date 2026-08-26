import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix crosshair variant of Investigate, drawn on the same 5x5 grid as the Shape
// library: four axis ticks (N/S/E/W) and a center dot, diagonals left empty. For
// comparison in storybook.ai-agent; not used anywhere in the app.
const BITMAP = ["..o..", ".....", "o.o.o", ".....", "..o.."];

export function CrosshairDotIcon({
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
