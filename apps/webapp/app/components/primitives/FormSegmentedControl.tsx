import { useState } from "react";
import { RadioGroup } from "@headlessui/react";
import { cn } from "~/utils/cn";

type Label = {
  name: string;
};

type FormSegmentedControlProps = {
  labels: Label[];
};

export default function FormSegmentedControl({
  labels,
}: FormSegmentedControlProps) {
  const [selected, setSelected] = useState(labels[0]);

  return (
    <div className="mx-auto flex h-8 w-fit rounded bg-slate-800 p-1">
      <RadioGroup value={selected} onChange={setSelected}>
        <div className="flex gap-x-1.5">
          {labels.map((label) => (
            <RadioGroup.Option
              key={label.name}
              value={label}
              className={({ active, checked }) =>
                `${
                  active
                    ? "focus-visible:ring focus-visible:ring-indigo-500 focus-visible:ring-opacity-60"
                    : ""
                }
                  ${
                    checked
                      ? "bg-slate-700 text-bright"
                      : "bg-transparent transition hover:bg-slate-750"
                  }
                    relative flex cursor-pointer rounded-[2px] px-3 py-[0.13rem] shadow-md focus:outline-none`
              }
            >
              {({ checked }) => (
                <>
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center">
                      <div className="text-sm">
                        <RadioGroup.Label
                          as="p"
                          className={cn(
                            "font-normal",
                            checked ? "text-bright" : "text-dimmed"
                          )}
                        >
                          {label.name}
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
