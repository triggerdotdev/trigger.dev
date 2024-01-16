export type ApiKeyType = {
  environment: "dev" | "prod";
  type: "server" | "public";
};

type Result =
  | {
      success: true;
    }
  | {
      success: false;
      type: ApiKeyType | undefined;
    };

export function checkApiKeyIsDevServer(apiKey: string): Result {
  const type = getApiKeyType(apiKey);

  if (!type) {
    return { success: false, type: undefined };
  }

  if (type.environment === "dev" && type.type === "server") {
    return {
      success: true,
    };
  }

  return {
    success: false,
    type,
  };
}

export function getApiKeyType(apiKey: string): ApiKeyType | undefined {
  if (apiKey.startsWith("tr_dev_")) {
    return {
      environment: "dev",
      type: "server",
    };
  }

  if (apiKey.startsWith("pk_dev_")) {
    return {
      environment: "dev",
      type: "public",
    };
  }

  // If they enter a prod key (tr_prod_), let them know
  if (apiKey.startsWith("tr_prod_")) {
    return {
      environment: "prod",
      type: "server",
    };
  }

  if (apiKey.startsWith("pk_prod_")) {
    return {
      environment: "prod",
      type: "public",
    };
  }

  return;
}
