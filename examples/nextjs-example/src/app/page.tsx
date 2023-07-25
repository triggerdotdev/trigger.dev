/* eslint-disable turbo/no-undeclared-env-vars */
import { SendTestEventButton } from "@/components/SendTestEvent";
import { TriggerProvider } from "@trigger.dev/react";

export default function Home() {
  return (
    <>
      <TriggerProvider
        publicApiKey={process.env.NEXT_PUBLIC_TRIGGER_API_KEY ?? ""}
        apiUrl="http://localhost:3030"
      >
        <main style={{ padding: "1rem" }}>
          <SendTestEventButton />
        </main>
      </TriggerProvider>
    </>
  );
}
