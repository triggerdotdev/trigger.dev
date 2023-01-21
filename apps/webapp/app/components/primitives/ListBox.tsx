import { Listbox } from "@headlessui/react";
import { ChevronUpDownIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";

type LabelProps = Parameters<typeof Listbox.Label>[0];
const labelClassName = "block text-sm font-medium text-gray-700";
function Label(props: LabelProps) {
  return (
    <Listbox className={classNames(labelClassName, props.className)} {...props}>
      {props.children}
    </Listbox>
  );
}

type ButtonProps = Parameters<typeof Listbox.Button>[0] & {
  children: React.ReactNode;
};

const buttonClassName =
  "relative w-full rounded bg-slate-700 py-2 pl-4 pr-10 text-slate-300 text-sm text-left shadow-md hover:cursor-pointer hover:bg-slate-600/80 transition";
function Button({ children, ...props }: ButtonProps) {
  return (
    <Listbox.Button
      className={classNames(buttonClassName, props.className)}
      {...props}
    >
      <span className="block truncate">{children}</span>
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
        <ChevronUpDownIcon
          className="h-5 w-5 text-gray-400"
          aria-hidden="true"
        />
      </span>
    </Listbox.Button>
  );
}

type OptionsProps = Parameters<typeof Listbox.Options>[0];
const optionsClassName =
  "absolute z-10 mt-1 max-h-96 w-full overflow-auto rounded p-1 bg-slate-700 text-base shadow-lg";
function Options(props: OptionsProps) {
  return (
    <Listbox.Options
      className={classNames(optionsClassName, props.className)}
      {...props}
    >
      {props.children}
    </Listbox.Options>
  );
}

type OptionProps = Parameters<typeof Listbox.Option>[0];
const optionClassName = "relative cursor-default select-none py-2 pl-3 pr-7";
const activeOptionClassName =
  "bg-slate-800 rounded hover:cursor-pointer font-bold";
const inactiveOptionClassName = "text-slate-300";
function Option(props: OptionProps) {
  return (
    <Listbox.Option
      className={({ active }: { active: boolean }) =>
        classNames(
          active ? activeOptionClassName : inactiveOptionClassName,
          optionClassName,
          props.className
        )
      }
      {...props}
    />
  );
}

export const StyledListBox = { Label, Button, Options, Option };
