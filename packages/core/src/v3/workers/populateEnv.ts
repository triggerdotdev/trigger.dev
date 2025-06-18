/**
 * Options for environment variable population
 */
interface PopulateEnvOptions {
  /**
   * Whether to override existing environment variables
   * @default false
   */
  override?: boolean;

  /**
   * Whether to enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * The previous environment variables
   * @default undefined
   */
  previousEnv?: Record<string, string>;
}

/**
 * Populates process.env with values from the provided object
 *
 * @param envObject - Object containing environment variables to set
 * @param options - Optional configuration
 */
export function populateEnv(
  envObject: Record<string, string>,
  options: PopulateEnvOptions = {}
): void {
  const { override = false, debug = false, previousEnv } = options;

  if (!envObject || typeof envObject !== "object") {
    return;
  }

  // Set process.env values
  for (const key of Object.keys(envObject)) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      if (override) {
        process.env[key] = envObject[key];

        if (debug) {
          console.log(`"${key}" is already defined and WAS overwritten`);
        }
      } else if (debug) {
        console.log(`"${key}" is already defined and was NOT overwritten`);
      }
    } else {
      process.env[key] = envObject[key];
    }
  }

  if (previousEnv) {
    // if there are any keys in previousEnv that are not in envObject, remove them from process.env
    for (const key of Object.keys(previousEnv)) {
      if (!Object.prototype.hasOwnProperty.call(envObject, key)) {
        delete process.env[key];
      }
    }
  }
}
