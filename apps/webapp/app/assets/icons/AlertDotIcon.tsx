import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix ("LED"/flip-dot) variant of an Alert bell icon, for the Investigate/Watch
// comparison set in storybook.ai-agent's shape library: a rounded bell body (circular
// annulus arc, "s" softening the edge) over a flared lip, with a clapper dot. Not used
// anywhere in the app.
const BITMAP = [
  ".....o.....",
  "....sss....",
  "...os.so...",
  "..o.....o..",
  "..o.....o..",
  "..o.....o..",
  "..ss...ss..",
  ".ooooooooo.",
  ".....o.....",
  "....ooo....",
  ".....o.....",
];

export function AlertDotIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <DotMatrixIcon bitmap={BITMAP} className={className} style={style} />;
}
