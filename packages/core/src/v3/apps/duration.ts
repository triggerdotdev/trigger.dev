export function parseNaturalLanguageDuration(duration: string): Date | undefined {
  const regexPattern = /^(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;

  const result: Date = new Date();
  let hasMatch = false;

  const elements = duration.match(regexPattern);
  if (elements) {
    if (elements[1]) {
      const weeks = Number(elements[1].slice(0, -1));
      if (weeks >= 0) {
        result.setDate(result.getDate() + 7 * weeks);
        hasMatch = true;
      }
    }
    if (elements[2]) {
      const days = Number(elements[2].slice(0, -1));
      if (days >= 0) {
        result.setDate(result.getDate() + days);
        hasMatch = true;
      }
    }
    if (elements[3]) {
      const hours = Number(elements[3].slice(0, -1));
      if (hours >= 0) {
        result.setHours(result.getHours() + hours);
        hasMatch = true;
      }
    }
    if (elements[4]) {
      const minutes = Number(elements[4].slice(0, -1));
      if (minutes >= 0) {
        result.setMinutes(result.getMinutes() + minutes);
        hasMatch = true;
      }
    }
    if (elements[5]) {
      const seconds = Number(elements[5].slice(0, -1));
      if (seconds >= 0) {
        result.setSeconds(result.getSeconds() + seconds);
        hasMatch = true;
      }
    }
  }

  if (hasMatch) {
    return result;
  }

  return undefined;
}
