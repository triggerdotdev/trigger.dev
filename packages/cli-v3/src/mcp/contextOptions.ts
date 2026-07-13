import { CLOUD_API_URL } from "../consts.js";
import type { McpCommandOptions } from "../commands/mcp.js";
import type { McpContextOptions } from "./context.js";
import type { FileLogger } from "./logger.js";

/**
 * Map parsed CLI options onto the `McpContext` options. `devOnly` must be
 * forwarded here or the context sees `undefined` and its dev-only guards
 * never fire.
 *
 * Kept in its own module (type-only imports) so the wiring can be
 * unit-tested without loading the full command/tool/build chain.
 */
export function toMcpContextOptions(
  options: McpCommandOptions,
  fileLogger: FileLogger | undefined
): McpContextOptions {
  return {
    projectRef: options.projectRef,
    fileLogger,
    apiUrl: options.apiUrl ?? CLOUD_API_URL,
    profile: options.profile,
    readonly: options.readonly,
    devOnly: options.devOnly,
  };
}
