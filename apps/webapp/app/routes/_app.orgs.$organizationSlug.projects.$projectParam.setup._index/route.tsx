import { FrameworkSelector } from "~/components/FrameworkSelector";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  expandSidebar: true,
};

export default function Page() {
  return (
    <>
      <FrameworkSelector />
    </>
  );
}
