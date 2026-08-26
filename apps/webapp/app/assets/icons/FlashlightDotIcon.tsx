import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix flashlight variant of Investigate, drawn on the same 5x5 grid as the Shape
// library: a solid body block top-left, and a cone of light spreading and thinning
// toward the bottom-right (one fewer dot per row out). For comparison in
// storybook.ai-agent; not used anywhere in the app.
const BITMAP = ["oo...", "oo.o.", ".o.o.", "..o.o", "...o."];

export function FlashlightDotIcon({
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
