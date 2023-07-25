/* eslint-disable turbo/no-undeclared-env-vars */

import { ReactQuery } from "@/components/ReactQuery";
import { TriggerProvider } from "@trigger.dev/react";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Home",
  description: "Welcome to Next.js",
};

export default function RootLayout({
  // Layouts must accept a children prop.
  // This will be populated with nested layouts or pages
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <TriggerProvider
          publicApiKey={process.env.NEXT_PUBLIC_TRIGGER_API_KEY ?? ""}
          apiUrl="http://localhost:3030"
        >
          <ReactQuery>{children}</ReactQuery>
        </TriggerProvider>
      </body>
    </html>
  );
}
