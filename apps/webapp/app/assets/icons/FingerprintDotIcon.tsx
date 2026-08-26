import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix fingerprint variant of Investigate, drawn on the same 5x5 grid as the
// Shape library: gapped, asymmetric arcs curling from top-left to bottom-right, like
// fingerprint ridges. For comparison in storybook.ai-agent; not used anywhere in the
// app.
const BITMAP = [".ooo.", "o....", "o.o..", "o.o.o", ".o.o."];

export function FingerprintDotIcon({
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
