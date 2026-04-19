import type { RBACPlugin } from "@trigger.dev/plugins";

export function create(): RBACPlugin {
  return {
    type: "rbac",
  };
}
