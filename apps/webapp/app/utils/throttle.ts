/** A throttle that fires the first call immediately and ensures the last call during the duration is also fired. */
export function throttle(
  func: (...args: any[]) => void,
  durationMs: number
): (...args: any[]) => void {
  let timeoutId: NodeJS.Timeout | null = null;
  let nextArgs: any[] | null = null;

  const wrapped = (...args: any[]) => {
    if (timeoutId) {
      nextArgs = args;
      return;
    }

    func(...args);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (nextArgs) {
        const argsToUse = nextArgs;
        nextArgs = null;
        wrapped(...argsToUse);
      }
    }, durationMs);
  };

  return wrapped;
}
