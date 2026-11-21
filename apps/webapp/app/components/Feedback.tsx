import { useSearchParams } from "@remix-run/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type FeedbackType } from "~/utils/feedback";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "./primitives/Dialog";
import { LazyLoad, lazyWithRetry } from "./primitives/LazyLoad";
import { Spinner } from "./primitives/Spinner";

const loadFeedbackForm = () => import("./FeedbackForm");
const FeedbackForm = lazyWithRetry(() =>
  loadFeedbackForm().then((module) => ({ default: module.FeedbackForm }))
);
const preloadFeedbackForm = () => void loadFeedbackForm();

type FeedbackProps = {
  button?: ReactNode;
  defaultValue?: FeedbackType;
  onOpenChange?: (open: boolean) => void;
} &
  // Controlled mode is all-or-none: pass both open + setOpen to host the dialog outside a popover
  // (so the popover closing can't unmount the form mid-submit and cancel the feedback POST), or
  // neither for the self-managed, button-triggered dialog. Passing only one is a broken half-state.
  ({ open?: never; setOpen?: never } | { open: boolean; setOpen: (open: boolean) => void });

export function Feedback({
  button,
  defaultValue = "bug",
  onOpenChange,
  open: openProp,
  setOpen: setOpenProp,
}: FeedbackProps) {
  const [openState, setOpenState] = useState(false);
  // Controlled when the caller passes open/setOpen (hosted outside a popover); otherwise self-managed.
  const open = openProp ?? openState;
  const setOpen = setOpenProp ?? setOpenState;
  const [searchParams, setSearchParams] = useSearchParams();
  const [type, setType] = useState<FeedbackType>(defaultValue);

  // Handle URL param functionality
  useEffect(() => {
    const open = searchParams.get("feedbackPanel");
    if (open) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setType(open as FeedbackType);
      setOpen(true);
      // Clone instead of mutating in place
      const next = new URLSearchParams(searchParams);
      next.delete("feedbackPanel");
      setSearchParams(next);
    }
  }, [searchParams, setOpen, setSearchParams]);

  // Reset the topic to the default once the dialog closes, so reopening always starts fresh. The
  // dialog is now persistently mounted (hosted outside the popover), so without this it would keep
  // the previously chosen topic selected and risk filing feedback under the wrong category. Keyed
  // on the close transition (not just `!open`) so the ?feedbackPanel= open path isn't clobbered.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      setType(defaultValue);
    }
    wasOpen.current = open;
  }, [open, defaultValue]);

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {button ? (
        <DialogTrigger asChild onPointerEnter={preloadFeedbackForm} onFocus={preloadFeedbackForm}>
          {button}
        </DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>Contact us</DialogHeader>
        <LazyLoad
          fallback={
            <div className="flex h-[22rem] items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <FeedbackForm type={type} setType={setType} setOpen={setOpen} />
        </LazyLoad>
      </DialogContent>
    </Dialog>
  );
}
