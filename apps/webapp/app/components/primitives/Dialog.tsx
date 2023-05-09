import { Dialog as HeadlessDialog, Transition } from "@headlessui/react";
import { forwardRef, Fragment } from "react";

type DialogProps = Parameters<typeof HeadlessDialog>[0] & {
  children: React.ReactNode;
};

//todo change to use ShadCn
function Dialog({ onClose, children, ...props }: DialogProps) {
  return (
    <Transition {...props}>
      <HeadlessDialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/70" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              {children}
            </Transition.Child>
          </div>
        </div>
      </HeadlessDialog>
    </Transition>
  );
}

type PanelProps = Parameters<typeof HeadlessDialog.Panel>[0];
const Panel = forwardRef((props: PanelProps, ref) => (
  <HeadlessDialog.Panel
    className="w-full max-w-xl transform overflow-hidden rounded-md bg-slate-800 p-10 text-left align-middle text-slate-200 shadow-md transition-all"
    {...props}
    ref={ref}
  />
));
Panel.displayName = "Dialog.Panel";

type TitleProps = Parameters<typeof HeadlessDialog.Title>[0];
const Title = forwardRef((props: TitleProps, ref) => (
  <HeadlessDialog.Title
    as="h3"
    className="text-2xl leading-6 text-slate-200"
    {...props}
    ref={ref}
  />
));
Title.displayName = "Dialog.Title";

export const StyledDialog = { Dialog, Panel, Title };
