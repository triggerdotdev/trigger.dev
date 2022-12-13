export interface SlackIntegration {
  sendMessage(message: string): Promise<void>;
}

export const slack = { id: "slack" } as unknown as SlackIntegration;
