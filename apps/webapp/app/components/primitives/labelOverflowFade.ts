const LABEL_OVERFLOW_MASK = "linear-gradient(to right, black calc(100% - 1.5rem), transparent)";

export function labelOverflowFadeStyle(isOverflowing: boolean) {
  return isOverflowing
    ? { maskImage: LABEL_OVERFLOW_MASK, WebkitMaskImage: LABEL_OVERFLOW_MASK }
    : undefined;
}
