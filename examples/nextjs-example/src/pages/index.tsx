/* eslint-disable turbo/no-undeclared-env-vars */
import Head from "next/head";
import { Inter } from "next/font/google";
import styles from "@/styles/Home.module.css";
import { TriggerProvider } from "@trigger.dev/react";

const inter = Inter({ subsets: ["latin"] });

export default function Home() {
  return (
    <>
      <Head>
        <title>Trigger.dev example</title>
      </Head>
      <main className={`${styles.main} ${inter.className}`}>
        <TriggerProvider
          publicApiKey={process.env.NEXT_PUBLIC_TRIGGER_API_KEY ?? ""}
        >
          <h1 className={styles.title}>Trigger.dev example</h1>
        </TriggerProvider>
      </main>
    </>
  );
}
