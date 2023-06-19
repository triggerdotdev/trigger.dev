export type OpenAIIntegrationOptions = {
  id: string;
  apiKey: string;
  organization?: string;
};

export type OpenAIIntegrationAuth = Omit<OpenAIIntegrationOptions, "id">;
