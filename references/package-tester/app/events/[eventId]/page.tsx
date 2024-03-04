import { ReactHooks } from "@/app/components/ReactHooks";

export default function Page({ params: { eventId } }: { params: { eventId: string } }) {
  return (
    <main className="h-screen w-full bg-charcoal-900">
      <div className="flex flex-col gap-y-6 mx-auto items-center pt-40">
        <div className="bg-charcoal-800 p-10 max-w-2xl items-center rounded-md border border-charcoal-700 flex flex-col gap-10 w-full">
          <ReactHooks eventId={eventId} />
        </div>
      </div>
    </main>
  );
}
