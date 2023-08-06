import { RadioGroup } from "@headlessui/react";
import { cn } from "~/utils/cn";

type Options = {
  label: string;
  value: string;
};

type FormSegmentedControlProps = {
  name: string;
  defaultValue?: string;
  options: Options[];
  onChange?: (value: string) => void;
};

export default function FormSegmentedControl({
  name,
  defaultValue,
  options,
  onChange,
}: FormSegmentedControlProps) {
  return (
    <div className="flex h-8 w-fit rounded bg-slate-800 p-1">
      <RadioGroup
        defaultValue={defaultValue ?? options[0].value}
        name={name}
        onChange={(c: string) => {
          if (onChange) {
            onChange(c);
          }
        }}
      >
        <div className="flex gap-x-1.5">
          {options.map((option) => (
            <RadioGroup.Option
              key={option.value}
              value={option.value}
              className={({ active, checked }) =>
                cn(
                  "relative flex cursor-pointer rounded-[2px] px-3 py-[0.13rem] shadow-md focus:outline-none",
                  active
                    ? "focus-visible:ring focus-visible:ring-indigo-500 focus-visible:ring-opacity-60"
                    : "",
                  checked
                    ? "bg-slate-700 text-bright"
                    : "bg-transparent transition hover:bg-slate-750"
                )
              }
            >
              {({ checked }) => (
                <>
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center">
                      <div className="text-sm">
                        <RadioGroup.Label
                          as="p"
                          className={cn("font-normal", checked ? "text-bright" : "text-dimmed")}
                        >
                          {option.label}
                        </RadioGroup.Label>
                      </div>
                    </div>
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
