"use client";

import * as React from "react";
import { Portal as PortalPrimitive } from "@radix-ui/react-portal";
import { cn } from "~/utils/cn";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { Header2 } from "./Headers";
import { NamedIcon } from "./NamedIcon";
import { createContext, createContextScope } from "@radix-ui/react-context";
import type { Scope } from "@radix-ui/react-context";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { useId } from "@radix-ui/react-id";
import { composeEventHandlers } from "@radix-ui/primitive";
import { useComposedRefs } from "@radix-ui/react-compose-refs";

const HELP_NAME = "Help";
type ScopedProps<P> = P & { __scopeHelp?: Scope };

const [createDialogContext, createDialogScope] =
  createContextScope("HELP_NAME");

type HelpProviderContextValue = {
  triggerRef: React.RefObject<HTMLButtonElement>;
  contentRef: React.RefObject<HelpContentElement>;
  contentId: string;
  titleId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenToggle(): void;
};
const [HelpProvider, useHelpContext] =
  createDialogContext<HelpProviderContextValue>(HELP_NAME);

type HelpProps = {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
};

export function Help({
  children,
  open: openProp,
  defaultOpen,
  onOpenChange,
  __scopeHelp,
}: ScopedProps<HelpProps>) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HelpContentElement>(null);
  const [open = false, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  return (
    <HelpProvider
      scope={__scopeHelp}
      triggerRef={triggerRef}
      contentRef={contentRef}
      contentId={useId()}
      titleId={useId()}
      open={open}
      onOpenChange={setOpen}
      onOpenToggle={React.useCallback(
        () => setOpen((prevOpen) => !prevOpen),
        [setOpen]
      )}
    >
      {children}
    </HelpProvider>
  );
}

function getState(open: boolean) {
  return open ? "open" : "closed";
}

/* -------------------------------------------------------------------------------------------------
 * HelpContent
 * -----------------------------------------------------------------------------------------------*/
const TRIGGER_NAME = "HelpTrigger";
type PrimitiveButtonProps = React.ComponentPropsWithoutRef<"button">;
interface HelpTriggerProps extends PrimitiveButtonProps {}

export const HelpTrigger = React.forwardRef<
  HTMLButtonElement,
  HelpTriggerProps
>(
  (
    { __scopeHelp, onClick, ...triggerProps }: ScopedProps<HelpTriggerProps>,
    forwardedRef
  ) => {
    const context = useHelpContext(TRIGGER_NAME, __scopeHelp);
    const composedTriggerRef = useComposedRefs(
      forwardedRef,
      context.triggerRef
    );
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={context.open}
        aria-controls={context.contentId}
        data-state={getState(context.open)}
        {...triggerProps}
        ref={composedTriggerRef}
        onClick={composeEventHandlers(onClick, context.onOpenToggle)}
      />
    );
  }
);

/* -------------------------------------------------------------------------------------------------
 * HelpPortal
 * -----------------------------------------------------------------------------------------------*/

const PORTAL_NAME = "HelpPortal";

type DialogPortalProps = React.ComponentPropsWithoutRef<
  typeof PortalPrimitive
> & {
  children?: React.ReactNode;
};

const DialogPortal = (props: ScopedProps<DialogPortalProps>) => {
  const { __scopeHelp, children, container } = props;
  const context = useHelpContext(PORTAL_NAME, __scopeHelp);
  return (
    <PortalProvider scope={__scopeHelp} forceMount={forceMount}>
      {React.Children.map(children, (child) => (
        <Presence present={context.open}>
          <PortalPrimitive asChild container={container}>
            {child}
          </PortalPrimitive>
        </Presence>
      ))}
    </PortalProvider>
  );
};

// export const HelpContent = React.forwardRef<
//   React.ElementRef<typeof HelpPrimitive.Content>,
//   HelpContentProps
// >(({ title, className, children, ...props }, ref) => {
//   const contentRef = React.useRef<HTMLDivElement>(null);

//   return (
//     <HelpPrimitive.Portal
//       className={cn(className)}
//       {...props}
//       container={contentRef.current}
//     >
//       <HelpPrimitive.Content
//         ref={contentRef}
//         className={cn("flex flex-col", className)}
//         {...props}
//       >
//         <div className="flex justify-between">
//           <div className="flex gap-1">
//             <NamedIcon name="lightbulb" className="h-3.5 w-3.5" />
//             <Header2>{title}</Header2>
//           </div>
//           <HelpPrimitive.Close className="flex gap-2">
//             <span>Dismiss</span>
//             <XMarkIcon className="h-4 w-4 text-slate-400" />
//           </HelpPrimitive.Close>
//         </div>
//         <div className="grow">{children}</div>
//       </HelpPrimitive.Content>
//     </HelpPrimitive.Portal>
//   );
// });
