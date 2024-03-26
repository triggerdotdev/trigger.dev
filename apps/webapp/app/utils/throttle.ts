//From: https://kettanaito.com/blog/debounce-vs-throttle

/** A very simple throttle. Will execute the function every Xms and discard any other calls during that period. */
export function throttle(
  func: (...args: any[]) => void,
  duration: number
): (...args: any[]) => void {
  let shouldWait = false;

  return (...args: any[]) => {
    if (!shouldWait) {
      func(...args);
      shouldWait = true;

      setTimeout(() => {
        shouldWait = false;
      }, duration);
    }
  };
}
