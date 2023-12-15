import { RadioGroup } from "@headlessui/react";
import { motion } from "framer-motion";
import { cn } from "~/utils/cn";

type Options = {
  label: string;
  value: string;
};

type SegmentedControlProps = {
  name: string;
  value?: string;
  defaultValue?: string;
  options: Options[];
  fullWidth?: boolean;
  onChange?: (value: string) => void;
};

export default function SegmentedControl({
  name,
  value,
  defaultValue,
  options,
  fullWidth,
  onChange,
}: SegmentedControlProps) {
  return (
    <div className={cn("flex h-10 rounded bg-slate-850", fullWidth ? "w-full" : "w-fit")}>
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
                  "relative flex h-full grow cursor-pointer text-center font-normal focus:outline-none",
                  active
                    ? "ring-offset-2 focus-visible:ring focus-visible:ring-indigo-500 focus-visible:ring-opacity-60"
                    : "",
                  checked
                    ? "text-bright"
                    : "rounded-[2px] text-dimmed transition hover:bg-slate-750/50 hover:text-bright"
                )
              }
            >
              {({ checked }) => (
                <>
                  <div className="relative flex h-full w-full items-center justify-between px-3 py-[0.13rem]">
                    <div className="z-10 flex h-full w-full items-center justify-center text-sm">
                      <RadioGroup.Label as="p">{option.label}</RadioGroup.Label>
                    </div>
                    {checked && (
                      <motion.div
                        layoutId={`segmented-control-${name}`}
                        transition={{ duration: 0.4, type: "spring" }}
                        className="absolute inset-0 rounded-[2px] bg-indigo-600 shadow-md"
                      ></motion.div>
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
