import MainApp from "@/components/main-app";
import { auth } from "@trigger.dev/sdk";

export default async function Home() {
  const publicAccessToken = await auth.createTriggerPublicToken("agent-loop-example");

  return <MainApp publicAccessToken={publicAccessToken} />;
}
