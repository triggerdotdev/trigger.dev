import { RadioGroup } from "@headlessui/react";
import { motion } from "framer-motion";
import { cn } from "~/utils/cn";

const variants = {
  primary: {
    base: "bg-charcoal-700",
    active: "text-text-bright hover:bg-charcoal-750/50",
  },
  secondary: {
    base: "bg-charcoal-700/50",
    active: "text-text-bright bg-charcoal-700 rounded-[2px] border border-charcoal-600/50",
  },
};

type Variants = keyof typeof variants;

type Options = {
  label: string;
  value: string;
};

type SegmentedControlProps = {
  name: string;
  value?: string;
  defaultValue?: string;
  options: Options[];
  variant?: Variants;
  fullWidth?: boolean;
  onChange?: (value: string) => void;
};

export default function SegmentedControl({
  name,
  value,
  defaultValue,
  options,
  variant = "secondary",
  fullWidth,
  onChange,
}: SegmentedControlProps) {
  return (
    <div
      className={cn(
        "flex h-10 rounded text-text-bright",
        variants[variant].base,
        fullWidth ? "w-full" : "w-fit"
      )}
    >
      <RadioGroup
        value={value}
        defaultValue={defaultValue ?? options[0].value}
        name={name}
        onChange={(c: string) => {
          if (onChange) {
            onChange(c);
          }
        }}
        className="w-full"
      >
        <div className="flex h-full w-full items-center justify-between gap-x-1 p-1">
          {options.map((option) => (
            <RadioGroup.Option
              key={option.value}
              value={option.value}
              className={({ active, checked }) =>
                cn(
                  "relative flex h-full grow cursor-pointer text-center font-normal focus-custom",
                  checked
                    ? variants[variant].active
                    : "text-text-dimmed transition hover:text-text-bright"
                )
              }
            >
              {({ checked }) => (
                <>
                  <div className="relative flex h-full w-full items-center justify-between px-3 py-[0.13rem]">
                    <div className="z-10 flex h-full w-full items-center justify-center text-sm">
                      <RadioGroup.Label as="p">{option.label}</RadioGroup.Label>
                    </div>
                    {checked && variant === "primary" && (
                      <motion.div
                        layoutId={`segmented-control-${name}`}
                        transition={{ duration: 0.4, type: "spring" }}
                        className="absolute inset-0 rounded-[2px] shadow-md outline outline-3 outline-primary"
                      />
                    )}
                  </div>
                </>
              )}
            </RadioGroup.Option>
          ))}
        </div>
      </RadioGroup>
    </div>
  );
}
