"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "react-query";

export function ReactQuery({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
