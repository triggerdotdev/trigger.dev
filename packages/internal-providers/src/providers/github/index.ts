import * as schemas from "./schemas";

export const github = {
  name: "GitHub",
  slug: "github",
  icon: "/integrations/github.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["repo"],
  },
  schemas,
};
