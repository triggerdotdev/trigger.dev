import { Listbox as HeadlessListbox, Transition } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { Fragment, createContext, forwardRef, useContext } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "secondary/small": {
    root: "",
    button:
      "text-xs h-6 bg-tertiary border border-tertiary group-hover:text-text-bright hover:border-charcoal-600 pr-1.5 pl-1.5 rounded-sm",
    options: "",
    option: "",
  },
};

type Variant = keyof typeof variants;

type ListboxProps = Omit<React.ComponentPropsWithRef<typeof HeadlessListbox>, "children"> & {
  variant?: Variant;
  width?: "content" | "full";
  children: React.ReactNode;
};

type ContextState = Pick<Required<ListboxProps>, "variant" | "width">;
const ListboxContext = createContext<ContextState>({} as ContextState);

const Root = forwardRef<React.ElementRef<typeof HeadlessListbox>, ListboxProps>(
  ({ className, children, width = "content", variant = "secondary/small", ...props }, ref) => {
    const variantClassName = variants[variant];
    return (
      <ListboxContext.Provider value={{ variant, width }}>
        <HeadlessListbox {...props}>
          <div className="relative">{children}</div>
        </HeadlessListbox>
      </ListboxContext.Provider>
    );
  }
);

type ButtonProps = Omit<React.ComponentPropsWithRef<typeof HeadlessListbox.Button>, "children"> & {
  children: React.ReactNode;
};

const Button = forwardRef<React.ElementRef<typeof HeadlessListbox.Button>, ButtonProps>(
  ({ className, children, ...props }, ref) => {
    const context = useContext(ListboxContext);
    const variantClassName = variants[context.variant];

    return (
      <HeadlessListbox.Button
        className={cn(
          "flex items-center gap-1 whitespace-nowrap",
          variantClassName.button,
          context.width === "full" ? "w-full" : "w-min",
          className
        )}
        {...props}
      >
        {(data) => {
          return (
            <>
              {children}
              <ChevronDown
                className={cn(
                  "size-4 text-text-dimmed transition group-hover:text-text-bright group-focus:text-text-bright"
                )}
              />
            </>
          );
        }}
      </HeadlessListbox.Button>
    );
  }
);

const Options = forwardRef<
  React.ElementRef<typeof HeadlessListbox.Options>,
  React.ComponentPropsWithRef<typeof HeadlessListbox.Options>
>(({ className, children, ...props }, ref) => {
  const context = useContext(ListboxContext);
  const variantClassName = variants[context.variant];

  return (
    <Transition
      as={Fragment}
      leave="transition ease-in duration-100"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <HeadlessListbox.Options
        className={cn(
          "absolute w-full overflow-auto",
          "mt-1 max-h-60 rounded-md bg-white py-1 text-xs shadow-lg ring-1 ring-black/5 focus:outline-none",
          variantClassName.options,
          className
        )}
        {...props}
        ref={ref}
      >
        {children}
      </HeadlessListbox.Options>
    </Transition>
  );
});

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
