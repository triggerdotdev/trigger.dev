export type DevCommandOptions = {
  projectPath: string;
};

export async function devCommand(options: DevCommandOptions) {
  // Read from package.json to get the endpointId
  // Read from .env.local to get the TRIGGER_API_KEY and TRIGGER_API_URL
  // Setup tunnel
  // Call triggerApi.registerEndpoint
  // Watch for changes to .ts files and call triggerApi.indexEndpoint
}
