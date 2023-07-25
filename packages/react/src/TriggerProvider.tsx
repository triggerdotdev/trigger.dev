"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { z } from "zod";

const publicApiKeyStartsWith = "pk_";
const privateApiKeyStartsWith = "tr_";

const ProviderContextSchema = z.object({
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

export const reactQueryContext = createContext<QueryClient | undefined>(
  undefined
);

export function TriggerProvider({
  publicApiKey,
  apiUrl,
  children,
}: TriggerProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  if (publicApiKey.startsWith(privateApiKeyStartsWith)) {
    throw new Error(
      `You are using a private API key, you should not do this because the value is visible to the client.`
    );
  }

  if (!publicApiKey.startsWith(publicApiKeyStartsWith)) {
    console.error(
      `TriggerProvider publicApiKey wasn't in the correct format. Should be ${publicApiKeyStartsWith}...`
    );
  }

  return (
    <ProviderContext.Provider
      value={{ publicApiKey, apiUrl: apiUrl ?? "https://api.trigger.dev" }}
    >
      <QueryClientProvider client={queryClient} context={reactQueryContext}>
        {children}
      </QueryClientProvider>
    </ProviderContext.Provider>
  );
}
