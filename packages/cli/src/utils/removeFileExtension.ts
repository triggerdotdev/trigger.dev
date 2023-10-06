export function removeFileExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}
