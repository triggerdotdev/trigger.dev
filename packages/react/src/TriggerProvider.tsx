"use client";

import React from "react";
import { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";

const publicApiKeyStartsWith = "pk_";
const privateApiKeyStartsWith = "tr_";

type ProviderContextValue = {
  publicApiKey: string;
  apiUrl: string;
  queryClient: QueryClient;
};

const ProviderContext = createContext<ProviderContextValue>({} as ProviderContextValue);

export function useTriggerProvider() {
  const value = useContext(ProviderContext);
  if (!value) {
    console.error(
      "You must have a TriggerProvider above where you're using Trigger.dev hooks in your React tree."
    );
  }
  return value;
}

type TriggerProviderProps = {
  publicApiKey: string;
  apiUrl?: string;
  children: React.ReactNode;
};

export function TriggerProvider({ publicApiKey, apiUrl, children }: TriggerProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  if (!publicApiKey) {
    throw new Error("TriggerProvider requires `publicApiKey` to be set with a value.");
  }

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
