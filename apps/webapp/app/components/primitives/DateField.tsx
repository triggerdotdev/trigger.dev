import { forwardRef } from "react";
import {
  DateField as OriginalDateField,
  DateInput as OriginalDateInput,
  DateSegment as OriginalDateSegment,
  Label as OriginalLabel,
} from "react-aria-components";
import { cn } from "~/utils/cn";

export const DateField = forwardRef<
  React.ElementRef<typeof OriginalDateField>,
  React.ComponentPropsWithoutRef<typeof OriginalDateField>
>((props, ref) => {
  return <OriginalDateField ref={ref} {...props} />;
});

export const DateInput = forwardRef<
  React.ElementRef<typeof OriginalDateInput>,
  React.ComponentPropsWithoutRef<typeof OriginalDateInput>
>((props, ref) => {
  return (
    <OriginalDateInput
      ref={ref}
      {...props}
      className={cn(
        "flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-500 ring-offset-background focus-within:border-indigo-500 focus-within:hover:border-indigo-500",
        props.className
      )}
    />
  );
});

export const DateSegment = forwardRef<
  React.ElementRef<typeof OriginalDateSegment>,
  React.ComponentPropsWithoutRef<typeof OriginalDateSegment>
>((props, ref) => {
  return (
    <OriginalDateSegment
      ref={ref}
      {...props}
      className={
        "box-content tabular-nums outline-none  focus:bg-indigo-500 focus:text-white  focus:ring-indigo-500"
      }
    />
  );
});

export const Label = forwardRef<
  React.ElementRef<typeof OriginalLabel>,
  React.ComponentPropsWithoutRef<typeof OriginalLabel>
>((props, ref) => {
  return <OriginalLabel ref={ref} {...props} />;
});
