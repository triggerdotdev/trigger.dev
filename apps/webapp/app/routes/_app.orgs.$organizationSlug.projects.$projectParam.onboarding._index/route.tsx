import Onboarding from "~/components/Onboarding";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  expandSidebar: true,
};

export default function Page() {
  return <Onboarding />;
}
