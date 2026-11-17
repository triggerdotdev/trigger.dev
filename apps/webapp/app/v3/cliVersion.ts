// Client-controlled and persisted, so cap what we accept
const CLI_VERSION_MAX_LENGTH = 128;

export function acceptedCliVersion(value: string | null | undefined): string | undefined {
  return value && value.length <= CLI_VERSION_MAX_LENGTH ? value : undefined;
}
