"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { z } from "zod";

const ProviderContextSchema = z.object({
  //matches the format "tr_p_dev_abcd1234"
  publicApiKey: z.string().startsWith("tr_p_"),
  apiUrl: z.string().optional(),
});

type ProviderContextValue = z.infer<typeof ProviderContextSchema>;

const ProviderContext = createContext<ProviderContextValue>(
  {} as ProviderContextValue
);

function useProvider() {
  const value = useContext(ProviderContext);
  const parsed = ProviderContextSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      `You must use the TriggerProvider component somewhere in your hierarchy, above where you perform queries.`
    );
  }

  return parsed;
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
  const values = ProviderContextSchema.safeParse({
    publicApiKey,
    apiUrl,
  });

  if (!values.success) {
    console.error(
      "TriggerProvider publicApiKey wasn't correct.",
      values.error.format()
    );
  }

  return (
    <ProviderContext.Provider value={{ publicApiKey, apiUrl }}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ProviderContext.Provider>
  );
}
