import "./globals.css";
import { TriggerProvider } from "@trigger.dev/react";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <TriggerProvider
          publicApiKey={process.env["NEXT_PUBLIC_TRIGGER_API_KEY"] ?? ""}
          apiUrl={process.env["NEXT_PUBLIC_TRIGGER_API_URL"]}
        >
          {children}
        </TriggerProvider>
      </body>
    </html>
  );
}
