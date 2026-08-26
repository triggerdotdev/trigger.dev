import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix spectacles variant of Investigate, drawn on the same 5x5 grid as the Shape
// library: two lens blocks with a gap for the bridge. For comparison against the
// magnifier in storybook.ai-agent; not used anywhere in the app.
const BITMAP = [".....", "oo.oo", "oo.oo", ".....", "....."];

export function InvestigateGlassesDotIcon({
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
