//From: https://kettanaito.com/blog/debounce-vs-throttle

/** A very simple throttle. Will execute the function at the end of each period and discard any other calls during that period. */
export function throttle<TArgs extends unknown[]>(
  func: (...args: TArgs) => void,
  durationMs: number
): (...args: TArgs) => void {
  let isPrimedToFire = false;

  return (...args: TArgs) => {
    if (!isPrimedToFire) {
      isPrimedToFire = true;

      setTimeout(() => {
        func(...args);
        isPrimedToFire = false;
      }, durationMs);
    }
  };
}
