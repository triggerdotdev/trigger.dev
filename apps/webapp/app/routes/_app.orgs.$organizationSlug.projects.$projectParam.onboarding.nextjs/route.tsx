import { SetupNextjs } from "~/components/SetupNextjs";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  expandSidebar: true,
};

export default function Page() {
  return (
    <>
      <SetupNextjs />
    </>
  );
}
