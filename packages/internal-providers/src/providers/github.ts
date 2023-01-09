import { Provider } from "../types";

export const githubProvider: Provider = {
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
        client_id: "abcdefg",
      },
    },
  },
};
