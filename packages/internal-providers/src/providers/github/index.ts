import * as schemas from "./schemas";

export const github = {
  name: "GitHub",
  slug: "github",
  icon: "/integrations/github.png",
  enabledFor: "all",
  authentication: {
    type: "oauth",
    scopes: ["repo"],
    environments: {
      development: {
        client_id: "cd763219ce4005e58c00",
      },
      production: {
        client_id: "98922f3fbb27485bae70",
      },
    },
  },
  schemas,
};
