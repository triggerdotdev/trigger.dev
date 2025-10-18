import { Streams } from "@/components/streams";
import { tasks } from "@trigger.dev/sdk";
import type { streamsTask } from "@/trigger/streams";

export default async function Home() {
  // Trigger the streams task
  const handle = await tasks.trigger<typeof streamsTask>("streams", {
    scenario: "markdown",
    tokenDelayMs: 20, // Slower streaming
  });

  console.log("handle", handle);

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
        <Streams accessToken={handle.publicAccessToken} runId={handle.id} />
      </main>
    </div>
  );
}
