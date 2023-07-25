"use client";

import { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";

const publicApiKeyStartsWith = "pk_";
const privateApiKeyStartsWith = "tr_";

type ProviderContextValue = {
  publicApiKey: string;
  apiUrl: string;
  queryClient: QueryClient;
};

const ProviderContext = createContext<ProviderContextValue>(
  {} as ProviderContextValue
);

export function useTriggerProvider() {
  const value = useContext(ProviderContext);
  verifyApiKey(value.publicApiKey);
  return value;
}

type TriggerProviderProps = {
  publicApiKey: string;
  apiUrl?: string;
  children: React.ReactNode;
};

export const reactQueryContext = createContext<QueryClient | undefined>(
  undefined
);

export function TriggerProvider({
  publicApiKey,
  apiUrl,
  children,
}: TriggerProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  verifyApiKey(publicApiKey);

  return (
    <ProviderContext.Provider
      value={{
        publicApiKey,
        apiUrl: apiUrl ?? "https://api.trigger.dev",
        queryClient,
      }}
    >
      {children}
    </ProviderContext.Provider>
  );
}

function verifyApiKey(apiKey: string) {
  if (apiKey.startsWith(privateApiKeyStartsWith)) {
    throw new Error(
      `You are using a private API key, you should not do this because the value is visible to the client.`
    );
  }

  if (!apiKey.startsWith(publicApiKeyStartsWith)) {
    console.error(
      `TriggerProvider publicApiKey wasn't in the correct format. Should be ${publicApiKeyStartsWith}...`
    );
  }
}
