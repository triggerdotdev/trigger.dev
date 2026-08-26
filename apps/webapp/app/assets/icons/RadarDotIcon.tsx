import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix radar variant of Investigate, drawn on the same 5x5 grid as the Shape
// library: a dotted circle, a sweep line from the center, and one blip dot breaking the
// ring's symmetry at the sweep's current position. For comparison in
// storybook.ai-agent; not used anywhere in the app.
const BITMAP = ["..o..", ".o.o.", "o.o.o", ".o.o.", "..o.o"];

export function RadarDotIcon({
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
