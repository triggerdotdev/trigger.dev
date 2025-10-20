import { TriggerButton } from "@/components/trigger-button";

export default function Home() {
  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
        <h1 className="text-3xl font-bold mb-4">Realtime Streams Test</h1>
        <p className="text-gray-600 mb-8">
          Click a button below to trigger a streaming task and watch it in real-time. You can
          refresh the page to test stream reconnection.
        </p>

        <div className="flex flex-col gap-4">
          <TriggerButton scenario="markdown">Markdown Stream</TriggerButton>
          <TriggerButton scenario="continuous">Continuous Stream</TriggerButton>
          <TriggerButton scenario="burst">Burst Stream</TriggerButton>
          <TriggerButton scenario="stall">Stall Stream (3 min)</TriggerButton>
          <TriggerButton scenario="slow-steady">Slow Steady Stream (5 min)</TriggerButton>
        </div>

        <div className="mt-8 pt-8 border-t border-gray-300">
          <h2 className="text-xl font-semibold mb-4">Performance Testing</h2>
          <TriggerButton scenario="performance" redirect="/performance">
            📊 Performance Test V1 (Latency Monitoring)
          </TriggerButton>

          <TriggerButton scenario="performance" redirect="/performance" useDurableStreams={true}>
            📊 Performance Test V2 (Latency Monitoring)
          </TriggerButton>
        </div>
      </main>
    </div>
  );
}
