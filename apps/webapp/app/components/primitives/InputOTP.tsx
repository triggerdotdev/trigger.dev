"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { MinusIcon } from "lucide-react";

import { cn } from "~/utils/cn";

const variants = {
  default: {
    container: "flex items-center gap-2 has-disabled:opacity-50",
    group: "flex items-center",
    slot: "data-[active=true]:border-ring data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:ring-destructive/20 dark:data-[active=true]:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[active=true]:aria-invalid:border-destructive dark:bg-input/30 border-input relative flex size-9 items-center justify-center border-y border-r text-sm outline-none transition-all first:rounded-l-md first:border-l last:rounded-r-md data-[active=true]:z-10 data-[active=true]:ring-[3px]",
  },
  large: {
    container: "flex items-center gap-3 has-disabled:opacity-50",
    group: "flex items-center gap-1",
    slot: "data-[active=true]:border-ring data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:ring-destructive/20 dark:data-[active=true]:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[active=true]:aria-invalid:border-destructive bg-charcoal-750 border-charcoal-700 hover:border-charcoal-600 hover:bg-charcoal-650 relative flex h-12 w-12 items-center justify-center border text-base outline-none transition-all rounded-md data-[active=true]:z-10 data-[active=true]:ring-[3px] data-[active=true]:border-indigo-500",
  },
  minimal: {
    container: "flex items-center gap-2 has-disabled:opacity-50",
    group: "flex items-center",
    slot: "data-[active=true]:border-ring data-[active=true]:ring-ring/50 border-transparent bg-transparent relative flex h-9 w-9 items-center justify-center border-b-2 border-b-charcoal-600 text-sm outline-none transition-all data-[active=true]:border-b-indigo-500 data-[active=true]:z-10",
  },
};

function InputOTP({
  className,
  containerClassName,
  variant = "default",
  fullWidth = false,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
  variant?: keyof typeof variants;
  fullWidth?: boolean;
}) {
  const variantStyles = variants[variant];

  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(variantStyles.container, fullWidth && "w-full", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({
  className,
  variant = "default",
  fullWidth = false,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: keyof typeof variants;
  fullWidth?: boolean;
}) {
  const variantStyles = variants[variant];

  return (
    <div
      data-slot="input-otp-group"
      className={cn(variantStyles.group, fullWidth && "flex-1 gap-1", className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  variant = "default",
  fullWidth = false,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
  variant?: keyof typeof variants;
  fullWidth?: boolean;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};
  const variantStyles = variants[variant];

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(variantStyles.slot, fullWidth && "flex-1", className)}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink h-4 w-px bg-text-bright duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-separator" role="separator" {...props}>
      <MinusIcon />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
