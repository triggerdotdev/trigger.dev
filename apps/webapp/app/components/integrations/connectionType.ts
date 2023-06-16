import type { ConnectionType } from "@trigger.dev/database";

export function connectionType(type: ConnectionType) {
  switch (type) {
    case "DEVELOPER":
      return "Developer";
    case "EXTERNAL":
      return "Your users";
  }
}
