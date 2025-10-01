import { ResourceMonitor } from "@trigger.dev/core/v3/serverOnly";
import { singleton } from "~/utils/singleton";

export const resourceMonitor = singleton("resourceMonitor", initializeResourceMonitor);

function initializeResourceMonitor() {
  return new ResourceMonitor({
    ctx: {},
    verbose: false,
  });
}
