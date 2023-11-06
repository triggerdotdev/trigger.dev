export function isValidRegex(regex: string) {
  try {
    new RegExp(regex);
    return true;
  } catch (err) {
    return false;
  }
}
