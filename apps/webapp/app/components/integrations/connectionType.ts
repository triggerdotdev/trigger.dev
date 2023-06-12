import { ApiConnectionType } from "~/models/apiConnection.server";

export function connectionType(type: ApiConnectionType) {
  switch (type) {
    case "DEVELOPER":
      return "Developer";
    case "EXTERNAL":
      return "Your users";
  }
}
