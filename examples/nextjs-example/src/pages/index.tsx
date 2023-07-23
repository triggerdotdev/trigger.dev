/* eslint-disable turbo/no-undeclared-env-vars */
import { EventTest } from "@/components/EventTest";
import styles from "@/styles/Home.module.css";
import { TriggerProvider } from "@trigger.dev/react";
import Head from "next/head";

export default function Home() {
  return (
    <>
      <TriggerProvider
        publicApiKey={process.env.NEXT_PUBLIC_TRIGGER_API_KEY ?? ""}
        apiUrl="http://localhost:3030"
      >
        <Head>
          <title>Trigger.dev example</title>
        </Head>
        <main>
          <EventTest />
        </main>
      </TriggerProvider>
    </>
  );
}
