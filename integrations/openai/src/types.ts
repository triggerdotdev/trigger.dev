export type OpenAIIntegrationOptions = {
  id: string;
  apiKey?: string;
  organization?: string;
  baseURL?: string;
  icon?: string;
};

export type OpenAIIntegrationAuth = Omit<OpenAIIntegrationOptions, "id">;
