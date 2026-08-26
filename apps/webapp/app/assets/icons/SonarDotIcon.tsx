import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix sonar-ping variant of Investigate, drawn on the same 5x5 grid as the Shape
// library: a center ping dot with two symmetric concentric dotted rings expanding
// outward. For comparison in storybook.ai-agent; not used anywhere in the app.
const BITMAP = ["..o..", ".o.o.", "o.o.o", ".o.o.", "..o.."];

export function SonarDotIcon({
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
