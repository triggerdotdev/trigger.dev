const NICE_STEPS = [1, 2, 2.5, 5];
const MAX_Y_TICKS = 5;
const MAX_X_TICKS = 7;

const DURATION_STEPS_MS = [
  1,
  2,
  5,
  10,
  20,
  25,
  50,
  100,
  200,
  250,
  500,
  ...[1, 2, 5, 10, 15, 30].map((s) => s * 1000),
  ...[1, 2, 5, 10, 15, 30].map((m) => m * 60_000),
  ...[1, 2, 3, 6, 12, 24].map((h) => h * 3_600_000),
];

function genericStep(top: number): number {
  const exp = Math.floor(Math.log10(top));
  for (let e = exp - 2; e <= exp + 1; e++) {
    for (const m of NICE_STEPS) {
      const step = m * 10 ** e;
      if (Math.ceil(top / step) <= MAX_Y_TICKS) return step;
    }
  }
  return top;
}

function niceStep(top: number, isDuration: boolean): number {
  if (isDuration) {
    const step = DURATION_STEPS_MS.find((s) => Math.ceil(top / s) <= MAX_Y_TICKS);
    if (step !== undefined) return step;
  }
  return genericStep(top);
}

export function niceYAxis(
  seriesMax: number,
  threshold: number | null,
  unit = ""
): { ticks: number[]; domain: [number, number]; step: number } {
  const factor = unit === "s" || unit === "seconds" ? 1000 : 1;
  const isDuration = factor === 1000 || unit === "ms" || unit === "duration_ms";
  const peak = Math.max(seriesMax * factor, (threshold ?? 0) * factor, 0);
  if (!(peak > 0)) return { ticks: [0, 1], domain: [0, 1], step: 1 };
  const top = peak * 1.05;
  const step = niceStep(top, isDuration);
  const count = Math.ceil(top / step - 1e-9);
  let ticks = Array.from({ length: count + 1 }, (_, i) => +(i * step).toPrecision(12));
  const thresholdScaled = threshold === null ? null : threshold * factor;
  if (thresholdScaled !== null && !ticks.includes(thresholdScaled)) {
    const lastIndex = ticks.length - 1;
    ticks = ticks.filter(
      (t, i) => i === 0 || i === lastIndex || Math.abs(t - thresholdScaled) >= step / 2
    );
    ticks.push(thresholdScaled);
    ticks.sort((a, b) => a - b);
  }
  const out = ticks.map((t) => +(t / factor).toPrecision(12));
  return { ticks: out, domain: [0, Math.max(...out)], step: step / factor };
}

export function stepDecimals(step: number): number {
  return String(+step.toPrecision(6)).split(".")[1]?.length ?? 0;
}

export function evenTimeTicks(buckets: number[]): number[] {
  const last = buckets.length - 1;
  if (buckets.length <= 8) return buckets;
  let n = 1;
  while (Math.floor(last / n) + 1 > MAX_X_TICKS) n++;
  const ticks: number[] = [];
  for (let i = 0; i <= last; i += n) ticks.push(buckets[i]!);
  return ticks;
}

export function withRaiseTick(ticks: number[], raise: number | undefined): number[] {
  if (raise === undefined) return ticks;
  const half = ticks.length > 1 ? (ticks[1]! - ticks[0]!) / 2 : 0;
  const kept = ticks.filter((t) => Math.abs(t - raise) >= half);
  return [...new Set([...kept, raise])].sort((a, b) => a - b);
}
