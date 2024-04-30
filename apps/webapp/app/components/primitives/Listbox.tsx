import { Listbox as HeadlessListbox } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { createContext, forwardRef, useContext } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "secondary/small": {
    root: "",
    button:
      "text-xs h-6 bg-tertiary border border-tertiary group-hover:text-text-bright hover:border-charcoal-600 pr-2 pl-1.5 whitespace-nowrap",
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

const ListboxContext = createContext<ContextState>({} as ContextState);

const Root = forwardRef<
  React.ElementRef<typeof HeadlessListbox>,
  React.ComponentPropsWithRef<typeof HeadlessListbox> & ListboxProps
>(({ className, children, width = "content", variant = "secondary/small", ...props }, ref) => {
  const variantClassName = variants[variant];
  return (
    <ListboxContext.Provider value={{ variant, width }}>
      <HeadlessListbox ref={ref} {...props}>
        {children}
      </HeadlessListbox>
    </ListboxContext.Provider>
  );
});

type ButtonProps = Omit<React.ComponentPropsWithRef<typeof HeadlessListbox.Button>, "children"> & {
  children: React.ReactNode;
};

const Button = forwardRef<React.ElementRef<typeof HeadlessListbox.Button>, ButtonProps>(
  ({ className, children, ...props }, ref) => {
    const context = useContext(ListboxContext);
    const variantClassName = variants[context.variant];

    const Children = children;
    return (
      <HeadlessListbox.Button
        className={cn(
          variantClassName.button,
          context.width === "full" ? "w-full" : "w-min",
          className
        )}
        {...props}
      >
        {(data) => {
          return <></>;
        }}
      </HeadlessListbox.Button>
    );
  }
);

function Options({
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

function Option({
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

export const Listbox = { Root, Button, Options, Option };
