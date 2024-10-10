import RunButton from "@/components/RunButton";
import BatchRunButton from "@/components/BatchRunButton";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col space-y-4">
        <RunButton />
        <BatchRunButton />
      </div>
    </main>
  );
}
