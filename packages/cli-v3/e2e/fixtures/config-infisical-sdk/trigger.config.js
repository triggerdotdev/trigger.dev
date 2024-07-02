import { InfisicalClient } from "@infisical/sdk";

export const config = async () => {
  console.log("InfisicalClient", InfisicalClient);

  return {
    project: "config-infisical-sdk",
  };
};
