import * as Ariakit from "@ariakit/react";
import {
  XMarkIcon,
  PlusIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  ChevronDownIcon,
} from "@heroicons/react/20/solid";
import { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { matchSorter } from "match-sorter";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";

const pillColors = [
  "bg-green-800/40 border-green-600/50",
  "bg-teal-800/40 border-teal-600/50",
  "bg-blue-800/40 border-blue-600/50",
  "bg-indigo-800/40 border-indigo-600/50",
  "bg-violet-800/40 border-violet-600/50",
  "bg-purple-800/40 border-purple-600/50",
  "bg-fuchsia-800/40 border-fuchsia-600/50",
  "bg-pink-800/40 border-pink-600/50",
  "bg-rose-800/40 border-rose-600/50",
  "bg-orange-800/40 border-orange-600/50",
  "bg-amber-800/40 border-amber-600/50",
  "bg-yellow-800/40 border-yellow-600/50",
  "bg-lime-800/40 border-lime-600/50",
  "bg-emerald-800/40 border-emerald-600/50",
  "bg-cyan-800/40 border-cyan-600/50",
  "bg-sky-800/40 border-sky-600/50",
];

function getPillColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return pillColors[Math.abs(hash) % pillColors.length];
}

export const TECHNOLOGY_OPTIONS = [
  "Angular",
  "Anthropic",
  "Astro",
  "AWS",
  "Azure",
  "BullMQ",
  "Bun",
  "Celery",
  "Clerk",
  "Cloudflare",
  "Cohere",
  "Convex",
  "Deno",
  "Docker",
  "Drizzle",
  "DynamoDB",
  "Elevenlabs",
  "Express",
  "Fastify",
  "Firebase",
  "Fly.io",
  "GCP",
  "GraphQL",
  "Hono",
  "Hugging Face",
  "Inngest",
  "Kafka",
  "Kubernetes",
  "Laravel",
  "LangChain",
  "Mistral",
  "MongoDB",
  "MySQL",
  "Neon",
  "Nest.js",
  "Next.js",
  "Node.js",
  "Nuxt",
  "OpenAI",
  "PlanetScale",
  "PostgreSQL",
  "Prisma",
  "RabbitMQ",
  "Railway",
  "React",
  "Redis",
  "Remix",
  "Render",
  "Replicate",
  "Resend",
  "SQLite",
  "Stripe",
  "Supabase",
  "SvelteKit",
  "Temporal",
  "tRPC",
  "Turso",
  "Upstash",
  "Vercel",
  "Vue",
] as const;

type TechnologyPickerProps = {
  value: string[];
  onChange: (value: string[]) => void;
  customValues: string[];
  onCustomValuesChange: (values: string[]) => void;
};

export function TechnologyPicker({
  value,
  onChange,
  customValues,
  onCustomValuesChange,
}: TechnologyPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [otherInputValue, setOtherInputValue] = useState("");
  const [showOtherInput, setShowOtherInput] = useState(false);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const allSelected = useMemo(() => [...value, ...customValues], [value, customValues]);

  const filteredOptions = useMemo(() => {
    if (!searchValue) return TECHNOLOGY_OPTIONS;
    return matchSorter([...TECHNOLOGY_OPTIONS], searchValue);
  }, [searchValue]);

  const toggleOption = useCallback(
    (option: string) => {
      if (value.includes(option)) {
        onChange(value.filter((v) => v !== option));
      } else {
        onChange([...value, option]);
      }
    },
    [value, onChange]
  );

  const removeItem = useCallback(
    (item: string) => {
      if (value.includes(item)) {
        onChange(value.filter((v) => v !== item));
      } else {
        onCustomValuesChange(customValues.filter((v) => v !== item));
      }
    },
    [value, onChange, customValues, onCustomValuesChange]
  );

  const addCustomValue = useCallback(() => {
    const trimmed = otherInputValue.trim();
    if (trimmed && !customValues.includes(trimmed) && !value.includes(trimmed)) {
      onCustomValuesChange([...customValues, trimmed]);
      setOtherInputValue("");
    }
  }, [otherInputValue, customValues, onCustomValuesChange, value]);

  const handleOtherKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        addCustomValue();
      }
    },
    [addCustomValue]
  );

  return (
    <div className="flex flex-col gap-2">
      {allSelected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allSelected.map((item) => (
            <span
              key={item}
              className={cn(
                "flex items-center gap-1 rounded-sm border py-0.5 pl-1.5 pr-1 text-xs font-medium text-white",
                getPillColor(item)
              )}
            >
              {item}
              <button
                type="button"
                onClick={() => removeItem(item)}
                className="ml-0.5 flex items-center hover:text-white/70"
              >
                <XMarkIcon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Ariakit.ComboboxProvider
        resetValueOnHide
        setValue={(val) => {
          setSearchValue(val);
        }}
      >
        <Ariakit.SelectProvider
          open={open}
          setOpen={setOpen}
          value={value}
          setValue={(v) => {
            if (Array.isArray(v)) {
              onChange(v);
            }
          }}
          virtualFocus
        >
          <Ariakit.Select
            className="group flex h-8 w-full items-center rounded bg-charcoal-750 pl-2 pr-2.5 text-sm text-text-dimmed ring-charcoal-600 transition focus-custom hover:bg-charcoal-650 hover:ring-1"
            onClick={() => setOpen(true)}
          >
            <div className="flex grow items-center">
              <CubeIcon className="mr-1.5 size-4 flex-none text-text-dimmed" />
              <span>Select your technologies…</span>
            </div>
            <ChevronDownIcon className="size-4 flex-none text-text-dimmed transition group-hover:text-text-bright" />
          </Ariakit.Select>

          <Ariakit.SelectPopover
            gutter={5}
            unmountOnHide
            className={cn(
              "z-50 flex flex-col overflow-clip rounded border border-charcoal-700 bg-background-bright shadow-md outline-none animate-in fade-in-40",
              "min-w-[max(180px,var(--popover-anchor-width))]",
              "max-w-[min(480px,var(--popover-available-width))]",
              "max-h-[min(400px,var(--popover-available-height))]"
            )}
          >
            <div className="flex h-9 w-full flex-none items-center gap-2 border-b border-grid-dimmed bg-transparent px-3 text-xs text-text-dimmed outline-none">
              <MagnifyingGlassIcon className="size-3.5 flex-none text-text-dimmed" />
              <Ariakit.Combobox
                autoSelect
                placeholder="Search technologies…"
                className="flex-1 bg-transparent text-xs text-text-dimmed outline-none"
              />
            </div>

            <Ariakit.ComboboxList className="overflow-y-auto overscroll-contain scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 focus-custom">
              {filteredOptions.map((option) => (
                <Ariakit.ComboboxItem
                  key={option}
                  className="group cursor-pointer px-1 pt-1 text-2sm text-text-dimmed focus-custom last:pb-1"
                  onClick={(e) => {
                    e.preventDefault();
                    toggleOption(option);
                  }}
                >
                  <div className="flex h-8 w-full items-center gap-2 rounded-sm px-2 group-data-[active-item=true]:bg-tertiary hover:bg-tertiary">
                    <div
                      className={cn(
                        "flex size-4 flex-none items-center justify-center rounded border",
                        value.includes(option)
                          ? "border-indigo-500 bg-indigo-600"
                          : "border-charcoal-600 bg-charcoal-700"
                      )}
                    >
                      {value.includes(option) && (
                        <svg className="size-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2.5 6L5 8.5L9.5 3.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="grow truncate text-text-bright">{option}</span>
                  </div>
                </Ariakit.ComboboxItem>
              ))}

              {filteredOptions.length === 0 && !searchValue && (
                <div className="px-3 py-2 text-xs text-text-dimmed">No options</div>
              )}

              {filteredOptions.length === 0 && searchValue && (
                <div className="px-3 py-2 text-xs text-text-dimmed">
                  No matches for &ldquo;{searchValue}&rdquo;
                </div>
              )}
            </Ariakit.ComboboxList>

            <div className="sticky bottom-0 border-t border-charcoal-700 bg-background-bright px-1 py-1">
              {showOtherInput ? (
                <div className="flex h-8 w-full items-center rounded-sm bg-tertiary pl-0 pr-2 ring-1 ring-charcoal-650">
                  <input
                    ref={otherInputRef}
                    type="text"
                    value={otherInputValue}
                    onChange={(e) => setOtherInputValue(e.target.value)}
                    onKeyDown={handleOtherKeyDown}
                    placeholder="Type and press Enter to add"
                    className="pl-0.5can flex-1 border-none bg-transparent text-2sm text-text-bright shadow-none outline-none ring-0 placeholder:text-text-dimmed focus:border-none focus:outline-none focus:ring-0"
                    autoFocus
                  />
                  <ShortcutKey
                    shortcut={{ key: "Enter" }}
                    variant="small"
                    className={cn(
                      "mr-1.5 transition-opacity duration-150",
                      otherInputValue.length > 0 ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setOtherInputValue("");
                      setShowOtherInput(false);
                    }}
                    className="flex items-center text-text-dimmed hover:text-text-bright"
                  >
                    <XMarkIcon className="size-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-2sm text-text-dimmed hover:bg-tertiary"
                  onClick={() => {
                    setShowOtherInput(true);
                    setTimeout(() => otherInputRef.current?.focus(), 0);
                  }}
                >
                  <PlusIcon className="size-4 flex-none" />
                  <span>Other (not listed)</span>
                </button>
              )}
            </div>
          </Ariakit.SelectPopover>
        </Ariakit.SelectProvider>
      </Ariakit.ComboboxProvider>
    </div>
  );
}
