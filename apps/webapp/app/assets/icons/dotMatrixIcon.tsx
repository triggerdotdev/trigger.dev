/**
 * Coarse dot-matrix ("LED"/flip-dot) rendering of an icon silhouette: a bitmap of "o"/"."
 * rows becomes a grid of `currentColor` circles at a fixed viewBox, so it drops in
 * anywhere a normal icon does. Used by the storybook-only dot-matrix icon variants —
 * not wired into any live UI.
 */
export function DotMatrixIcon({
  bitmap,
  className,
  style,
  size = 24,
  dotRadius = 1.15,
}: {
  /** Equal-length rows, "o" = dot on. Read top to bottom, left to right. */
  bitmap: string[];
  className?: string;
  /** `width`/`height` here override `size`, matching how heroicons is usually sized. */
  style?: React.CSSProperties;
  size?: number;
  dotRadius?: number;
}) {
  const rows = bitmap.length;
  const cols = bitmap[0]?.length ?? 0;
  const cellW = size / cols;
  const cellH = size / rows;

  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      {bitmap.flatMap((row, r) =>
        [...row].map((cell, c) =>
          cell === "o" ? (
            <circle
              key={`${r}-${c}`}
              cx={c * cellW + cellW / 2}
              cy={r * cellH + cellH / 2}
              r={dotRadius}
            />
          ) : null
        )
      )}
    </svg>
  );
}
