// Telemetry must see the project's profile, so it is adopted before the session starts.
export async function handleInitialized(deps: {
  loadProjectProfile: () => Promise<void>;
  sessionStarted: () => void;
}) {
  await deps.loadProjectProfile().catch(() => {});
  deps.sessionStarted();
}

export function adoptProjectProfile(
  options: { profile?: string },
  configProfile: string | undefined,
  onChanged: () => void
) {
  if (!configProfile || configProfile === options.profile) return false;
  options.profile = configProfile;
  onChanged();
  return true;
}
