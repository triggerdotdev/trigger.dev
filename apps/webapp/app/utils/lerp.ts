/** Linearly interpolates between the min/max values, using t.
 * It can't go outside the range   */
export function lerp(min: number, max: number, t: number) {
  return min + (max - min) * clamp(t, 0, 1);
}

/** Inverse lerp */
export function inverseLerp(min: number, max: number, value: number) {
  return (value - min) / (max - min);
}

/** Clamps a value between a min and max */
export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
