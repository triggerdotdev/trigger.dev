/** A uat identity has already been rechecked against its source PAT by the bearer authenticator. */
export type McpIdentity =
  | { kind: "pat"; userId: string; tokenId: string }
  | {
      kind: "uat";
      userId: string;
      sourceTokenId: string;
      clientId?: string;
      cap?: string[];
      organizationId?: string;
      environmentId?: string;
    };
