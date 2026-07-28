/**
 * Right-edge gradient fade for labels that clip, used instead of a hard cut or an ellipsis. Apply
 * it only while the text actually overflows — masking a label that fits would fade its last
 * characters for no reason.
 */
const LABEL_OVERFLOW_MASK = "linear-gradient(to right, black calc(100% - 1.5rem), transparent)";

/** Mask style for a clipping label, or nothing when the text fits. Spread into a `style` prop. */
export function labelOverflowFadeStyle(isOverflowing: boolean) {
  return isOverflowing
    ? { maskImage: LABEL_OVERFLOW_MASK, WebkitMaskImage: LABEL_OVERFLOW_MASK }
    : undefined;
}
