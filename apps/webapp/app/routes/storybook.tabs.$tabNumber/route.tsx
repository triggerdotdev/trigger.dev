import { useParams } from "@remix-run/react";

export default function Story() {
  const { tabNumber } = useParams();
  return (
    <div className="flex items-center justify-center py-8">
      <h1 className="text-5xl">{tabNumber}</h1>
    </div>
  );
}
