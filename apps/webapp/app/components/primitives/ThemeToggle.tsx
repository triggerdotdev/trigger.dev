import { ComputerDesktopIcon, MoonIcon, SunIcon } from "@heroicons/react/20/solid";
import { useTheme } from "./ThemeProvider";
import { Popover, PopoverContent, PopoverMenuItem, PopoverTrigger } from "./Popover";
import { Button } from "./Buttons";
import { SimpleTooltip } from "./Tooltip";
import { cn } from "~/utils/cn";
import { useState } from "react";
import type { ThemePreference } from "~/services/dashboardPreferences.server";

const themeOptions: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: ComputerDesktopIcon },
];

interface ThemeToggleProps {
  className?: string;
  isCollapsed?: boolean;
}

export function ThemeToggle({ className, isCollapsed = false }: ThemeToggleProps) {
  const { themePreference, setThemePreference } = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  const currentOption = themeOptions.find((opt) => opt.value === themePreference) ?? themeOptions[1];
  const CurrentIcon = currentOption.icon;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger asChild>
            <Button
              variant="minimal/small"
              className={cn("aspect-square h-7 p-1", className)}
              LeadingIcon={CurrentIcon}
            />
          </PopoverTrigger>
        }
        content={`Theme: ${currentOption.label}`}
        side={isCollapsed ? "right" : "top"}
        hidden={isOpen}
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[10rem] p-1"
        side={isCollapsed ? "right" : "top"}
        align="start"
        sideOffset={8}
      >
        {themeOptions.map((option) => (
          <PopoverMenuItem
            key={option.value}
            icon={option.icon}
            title={option.label}
            isSelected={themePreference === option.value}
            onClick={() => {
              setThemePreference(option.value);
              setIsOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface ThemeToggleButtonsProps {
  className?: string;
}

export function ThemeToggleButtons({ className }: ThemeToggleButtonsProps) {
  const { themePreference, setThemePreference } = useTheme();

  return (
    <div className={cn("flex items-center gap-1 rounded-md bg-tertiary p-0.5", className)}>
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const isSelected = themePreference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setThemePreference(option.value)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
              isSelected
                ? "bg-background-bright text-text-bright shadow-sm"
                : "text-text-dimmed hover:text-text-bright"
            )}
            title={option.label}
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
