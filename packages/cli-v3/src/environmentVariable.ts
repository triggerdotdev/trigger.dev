export function getEnvironmentVariable({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue?: string;
}): string | undefined {
  return process.env[name] ?? defaultValue;
}
