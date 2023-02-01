import { XMarkIcon, DevicePhoneMobileIcon } from "@heroicons/react/24/outline";
import { PrimaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";

export function NoMobileOverlay() {
  return (
    <>
      <div className="fixed inset-0 z-[9999] flex items-center justify-center sm:hidden">
        <div className="relative bg-black opacity-90 h-full w-full"></div>
        <div className="absolute flex flex-col gap-6 mx-8 items-center bg-slate-850 px-8 py-10 text-center rounded-lg">
          <XMarkIcon className="absolute top-14 h-8 w-8 text-rose-600" />
          <DevicePhoneMobileIcon className="h-16 w-16 text-slate-500" />
          <Body className="text-slate-300">
            Trigger.dev is currently only available on desktop.
          </Body>
          <PrimaryA href="https://trigger.dev">Back Home</PrimaryA>
        </div>
      </div>
    </>
  );
}
