//From: https://kettanaito.com/blog/debounce-vs-throttle

/** A very simple throttle. Will execute the function at the end of each period and discard any other calls during that period. */
export function throttle(
  func: (...args: any[]) => void,
  durationMs: number
): (...args: any[]) => void {
  let isPrimedToFire = false;

  return (...args: any[]) => {
    if (!isPrimedToFire) {
      isPrimedToFire = true;

      setTimeout(() => {
        func(...args);
        isPrimedToFire = false;
      }, durationMs);
    }
  };
}
