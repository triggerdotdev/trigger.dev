import { dotMatrixGeometry, MATRIX } from "~/components/primitives/AgentDotMatrix";

/**
 * A silhouette drawn on the exact same grid as the Shape library's `AgentDotMatrix`
 * shapes ("Face options" in storybook.ai-agent): `MATRIX`x`MATRIX` nodes, same pitch,
 * same dot radius (`dotMatrixGeometry`) — every lit dot sits on a grid node, none
 * off-grid, none resized. `currentColor`, so it drops in anywhere a normal icon does.
 * Used by the storybook-only dot-matrix icon variants — not wired into any live UI.
 */
export function DotMatrixIcon({
  bitmap,
  className,
  style,
  size = 24,
  /** Faint always-visible grid, matching "Face options" (`gridAtRest`) at its own default opacity. */
  showGrid = false,
  gridOpacity = 0.18,
}: {
  /** Exactly `MATRIX` rows of `MATRIX` chars: "o" = lit, "." = off. */
  bitmap: string[];
  className?: string;
  /** `width`/`height` here override `size`, matching how heroicons is usually sized. */
  style?: React.CSSProperties;
  size?: number;
  showGrid?: boolean;
  gridOpacity?: number;
}) {
  const { pitch, dotR } = dotMatrixGeometry(size);
  const center = (i: number) => i * pitch + pitch / 2;

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
      {showGrid &&
        Array.from({ length: MATRIX * MATRIX }, (_, i) => {
          const r = Math.floor(i / MATRIX);
          const c = i % MATRIX;
          return (
            <circle
              key={`ghost-${r}-${c}`}
              cx={center(c)}
              cy={center(r)}
              r={dotR}
              opacity={gridOpacity}
            />
          );
        })}
      {bitmap.flatMap((row, r) =>
        [...row].map((cell, c) =>
          cell === "o" ? <circle key={`${r}-${c}`} cx={center(c)} cy={center(r)} r={dotR} /> : null
        )
      )}
    </svg>
  );
}
