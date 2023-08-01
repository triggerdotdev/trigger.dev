import { EventRunData } from "@/components/RunDetails";

export default function Page({ params: { eventId } }: { params: { eventId: string } }) {
  return (
    <main style={{ padding: "1rem" }}>
      <EventRunData id={eventId} />
    </main>
  );
}
