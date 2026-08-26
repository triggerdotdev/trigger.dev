import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) spectacles variant of Investigate, for comparison against
// the magnifier in storybook.ai-agent's shape library: two rounded lens rings (circular
// annuli, "s" softening the edge) joined by a short bridge. Not used anywhere in the app.
const BITMAP = [
  "................",
  "..sos......sos..",
  ".ss..o....ss..o.",
  ".o...s.oo.o...s.",
  ".o...o....o...o.",
  "..osss.....osss.",
  "................",
];

export function InvestigateGlassesDotIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <DotMatrixIcon bitmap={BITMAP} className={className} style={style} />;
}
