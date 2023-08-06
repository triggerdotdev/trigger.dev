import { XMarkIcon, DevicePhoneMobileIcon } from "@heroicons/react/24/outline";
import { Paragraph } from "./primitives/Paragraph";
import { LinkButton } from "./primitives/Buttons";

export function NoMobileOverlay() {
  return (
    <>
      <div className="fixed inset-0 z-[9999] flex items-center justify-center sm:hidden">
        <div className="relative h-full w-full bg-black opacity-90"></div>
        <div className="absolute mx-8 flex flex-col items-center gap-6 rounded-lg bg-slate-850 px-8 py-10 text-center">
          <XMarkIcon className="absolute top-14 h-8 w-8 text-rose-600" />
          <DevicePhoneMobileIcon className="h-16 w-16 text-slate-500" />
          <Paragraph>Trigger.dev is currently only available on desktop.</Paragraph>
          <LinkButton to="https://trigger.dev" variant="primary/medium">
            Back Home
          </LinkButton>
        </div>
      </div>
    </>
  );
}
