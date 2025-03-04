/** A very simple debounce. Will only execute after the specified delay has elapsed since the last call. */
export function debounce(
  func: (...args: any[]) => void,
  delayMs: number
): (...args: any[]) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: any[]) => {
    // Clear any existing timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Set a new timeout with the latest args
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delayMs);
  };
}
