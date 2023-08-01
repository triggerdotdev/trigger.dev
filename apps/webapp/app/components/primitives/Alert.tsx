"use client";

import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "~/utils/cn";

const Alert = AlertDialogPrimitive.Root;

const AlertTrigger = AlertDialogPrimitive.Trigger;

const AlertPortal = ({
  className,
  children,
  ...props
}: AlertDialogPrimitive.AlertDialogPortalProps) => (
  <AlertDialogPrimitive.Portal className={cn(className)} {...props}>
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {children}
    </div>
  </AlertDialogPrimitive.Portal>
);
AlertPortal.displayName = AlertDialogPrimitive.Portal.displayName;

const AlertOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, children, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity animate-in fade-in",
      className
    )}
    {...props}
    ref={ref}
  />
));
AlertOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <AlertPortal>
    <AlertOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 grid w-full max-w-lg scale-100 gap-4 border bg-background p-6 opacity-100 shadow-lg animate-in fade-in-90 slide-in-from-bottom-10 sm:rounded-lg sm:zoom-in-90 sm:slide-in-from-bottom-0 md:w-full",
        className
      )}
      {...props}
    />
  </AlertPortal>
));
AlertContent.displayName = AlertDialogPrimitive.Content.displayName;

const AlertHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
);
AlertHeader.displayName = "AlertDialogHeader";

const AlertFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
AlertFooter.displayName = "AlertDialogFooter";

const AlertTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold", className)}
    {...props}
  />
));
AlertTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertDescription.displayName = AlertDialogPrimitive.Description.displayName;

const AlertAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Action ref={ref} className={cn(className)} {...props} />
));
AlertAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel ref={ref} className={cn("mt-2 sm:mt-0", className)} {...props} />
));
AlertCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  Alert,
  AlertTrigger,
  AlertContent,
  AlertHeader,
  AlertFooter,
  AlertTitle,
  AlertDescription,
  AlertAction,
  AlertCancel,
};
