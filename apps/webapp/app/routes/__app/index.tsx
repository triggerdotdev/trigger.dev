import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";

export const loader = async ({ request }: LoaderArgs) => {
  return typedjson({});
};

export default function AppLayout() {
  return (
    <div className="flex h-screen flex-col overflow-auto">
      adsadsdasasd asads asa dsa ds ads
    </div>
  );
}
