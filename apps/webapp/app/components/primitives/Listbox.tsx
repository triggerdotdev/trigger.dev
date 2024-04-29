import { Listbox as HeadlessListbox } from "@headlessui/react";
import { createContext, forwardRef, useContext } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "secondary/small": {
    root: "text-xs h-6 bg-tertiary border border-tertiary group-hover:text-text-bright hover:border-charcoal-600 pr-2 pl-1.5",
    button: "",
    options: "",
    option: "",
  },
};

type Variant = keyof typeof variants;

type ListboxProps = {
  variant?: Variant;
  width?: "content" | "full";
};

type ContextState = Required<ListboxProps>;

export const ListboxContext = createContext<ContextState>({} as ContextState);

export const Listbox = forwardRef<
  React.ElementRef<typeof HeadlessListbox>,
  React.ComponentPropsWithoutRef<typeof HeadlessListbox> & ListboxProps
>(({ className, children, width = "content", variant = "secondary/small", ...props }, ref) => {
  const variantClassName = variants[variant];
  return (
    <ListboxContext.Provider value={{ variant, width }}>
      <Listbox
        ref={ref}
        className={cn(
          "ring-offset-background focus-visible:ring-ring group flex items-center justify-between gap-x-1 rounded text-text-dimmed transition placeholder:text-text-dimmed hover:text-text-bright focus-visible:bg-tertiary focus-visible:text-text-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
          width === "full" ? "w-full" : "w-min",
          variantClassName.root,
          className
        )}
        {...props}
      >
        {children}
      </Listbox>
    </ListboxContext.Provider>
  );
});

export function ListboxButton({
  className,
  children,
  ...props
}: React.ComponentPropsWithRef<typeof HeadlessListbox.Button>) {
  const context = useContext(ListboxContext);
  const variantClassName = variants[context.variant];

  return (
    <HeadlessListbox.Button className={cn(variantClassName.button, className)} {...props}>
      {children}
    </HeadlessListbox.Button>
  );
}

export function ListboxOptions({
  className,
  children,
  ...props
}: React.ComponentPropsWithRef<typeof HeadlessListbox.Options>) {
  const context = useContext(ListboxContext);
  const variantClassName = variants[context.variant];

  return (
    <HeadlessListbox.Options className={cn(variantClassName.options, className)} {...props}>
      {children}
    </HeadlessListbox.Options>
  );
}

export function ListboxOption({
  className,
  value,
  children,
  ...props
}: React.ComponentPropsWithRef<typeof HeadlessListbox.Option> & { value: string }) {
  const context = useContext(ListboxContext);
  const variantClassName = variants[context.variant];

  return (
    <HeadlessListbox.Option
      value={value}
      className={cn(variantClassName.option, className)}
      {...props}
    >
      {children}
    </HeadlessListbox.Option>
  );
}
