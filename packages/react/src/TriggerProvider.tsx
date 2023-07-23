"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { z } from "zod";

const publicApiKeyStartsWith = "pub_tr";
const privateApiKeyStartsWith = "tr_";

const ProviderContextSchema = z.object({
  //matches the format "tr_p_dev_abcd1234"
  publicApiKey: z.string().startsWith(publicApiKeyStartsWith),
  apiUrl: z.string(),
});

type ProviderContextValue = z.infer<typeof ProviderContextSchema>;

const ProviderContext = createContext<ProviderContextValue>(
  {} as ProviderContextValue
);

export function useTriggerProvider() {
  const value = useContext(ProviderContext);
  const parsed = ProviderContextSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      `You must use the TriggerProvider component somewhere in your hierarchy, above where you perform queries.`
    );
  }

  return parsed.data;
}

type TriggerProviderProps = {
  publicApiKey: string;
  apiUrl?: string;
  children: React.ReactNode;
};

const queryClient = new QueryClient();

export function TriggerProvider({
  publicApiKey,
  apiUrl,
  children,
}: TriggerProviderProps) {
  if (!publicApiKey.startsWith(publicApiKeyStartsWith)) {
    if (publicApiKey.startsWith(privateApiKeyStartsWith)) {
      throw new Error(
        `You are using a private API key. You must use a public API key.`
      );
    }

    console.error(
      `TriggerProvider publicApiKey wasn't in the correct format. Should be ${publicApiKeyStartsWith}...`
    );
  }

  return (
    <ProviderContext.Provider
      value={{ publicApiKey, apiUrl: apiUrl ?? "https://api.trigger.dev" }}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ProviderContext.Provider>
  );
}
