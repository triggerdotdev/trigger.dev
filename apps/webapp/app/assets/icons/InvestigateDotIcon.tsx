import { DotMatrixIcon } from "./dotMatrixIcon";

// Dot-matrix variant of the Investigate action's magnifying-glass icon (heroicons
// `MagnifyingGlassIcon`), drawn on the same 5x5 grid as the Shape library — a rounded
// ring (the "circle" shape) with one corner extended into a handle stub. For comparison
// in storybook.ai-agent; not used anywhere in the app.
const BITMAP = [".ooo.", "o...o", "o...o", "o...o", ".oooo"];

export function InvestigateDotIcon({
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
