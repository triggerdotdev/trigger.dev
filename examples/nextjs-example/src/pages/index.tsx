/* eslint-disable turbo/no-undeclared-env-vars */
import Head from "next/head";
import { Inter } from "next/font/google";
import styles from "@/styles/Home.module.css";
import { TriggerProvider, useQueryEvent } from "@trigger.dev/react";
import { EventTest } from "@/components/EventTest";

const inter = Inter({ subsets: ["latin"] });

export default function Home() {
  return (
    <>
      <TriggerProvider
        publicApiKey={process.env.NEXT_PUBLIC_TRIGGER_API_KEY ?? ""}
      >
        <Head>
          <title>Trigger.dev example</title>
        </Head>
        <main className={`${styles.main} ${inter.className}`}>
          <h1 className={styles.title}>Event</h1>
          <EventTest />
        </main>
      </TriggerProvider>
    </>
  );
}
