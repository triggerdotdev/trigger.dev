import { RadioGroup } from "@headlessui/react";
import { motion } from "framer-motion";
import { cn } from "~/utils/cn";

const sizes = {
  small: {
    control: "h-6",
    option: "px-2 text-xs",
    container: "gap-x-0.5",
  },
  medium: {
    control: "h-10",
    option: "px-3 py-[0.13rem] text-sm",
    container: "p-1 gap-x-0.5",
  },
};

const theme = {
  primary: {
    base: "bg-charcoal-700",
    active: "text-text-bright hover:bg-charcoal-750/50",
    inactive: "text-text-dimmed transition hover:text-text-bright",
    selected: "absolute inset-0 rounded-[2px] outline outline-3 outline-primary",
  },
  secondary: {
    base: "bg-charcoal-700/50",
    active: "text-text-bright",
    inactive: "text-text-dimmed transition hover:text-text-bright",
    selected: "absolute inset-0 rounded bg-charcoal-700 border border-charcoal-600",
  },
};

type Size = keyof typeof sizes;
type Theme = keyof typeof theme;

type VariantStyle = {
  base: string;
  active: string;
  inactive: string;
  option: string;
  container: string;
  selected: string;
};

function createVariant(sizeName: Size, themeName: Theme): VariantStyle {
  return {
    base: cn(sizes[sizeName].control, theme[themeName].base),
    active: theme[themeName].active,
    inactive: theme[themeName].inactive,
    option: sizes[sizeName].option,
    container: sizes[sizeName].container,
    selected: theme[themeName].selected,
  };
}

const variants = {
  "primary/small": createVariant("small", "primary"),
  "primary/medium": createVariant("medium", "primary"),
  "secondary/small": createVariant("small", "secondary"),
  "secondary/medium": createVariant("medium", "secondary"),
} as const;

type VariantType = keyof typeof variants;

type Options = {
  label: string;
  value: string;
};

type SegmentedControlProps = {
  name: string;
  value?: string;
  defaultValue?: string;
  options: Options[];
  variant?: VariantType;
  fullWidth?: boolean;
  onChange?: (value: string) => void;
};

export default function SegmentedControl({
  name,
  value,
  defaultValue,
  options,
  variant = "secondary/medium",
  fullWidth,
  onChange,
}: SegmentedControlProps) {
  const variantStyle = variants[variant];
  const isPrimary = variant.startsWith("primary");

  return (
    <div
      className={cn(
        "flex rounded text-text-bright",
        variantStyle.base,
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
        <div
          className={cn("flex h-full w-full items-center justify-between", variantStyle.container)}
        >
          {options.map((option) => (
            <RadioGroup.Option
              key={option.value}
              value={option.value}
              className={({ checked }) =>
                cn(
                  "relative flex h-full grow cursor-pointer text-center font-normal focus-custom",
                  checked ? variantStyle.active : variantStyle.inactive
                )
              }
            >
              {({ checked }) => (
                <>
                  <div
                    className={cn(
                      "relative flex h-full w-full items-center justify-between",
                      variantStyle.option
                    )}
                  >
                    <div className="z-10 flex h-full w-full items-center justify-center">
                      <RadioGroup.Label as="p">{option.label}</RadioGroup.Label>
                    </div>
                    {checked && (
                      <motion.div
                        layoutId={`segmented-control-${name}`}
                        transition={{ duration: 0.4, type: "spring" }}
                        className={variantStyle.selected}
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
