import { XMarkIcon } from "@heroicons/react/20/solid";
import { useFetcher, useNavigate } from "@remix-run/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Input } from "~/components/primitives/Input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { objectToSearchParams } from "~/utils/searchParams";
import { type TaskRunListSearchFilters } from "./RunFilters";

type AIFilterResult =
  | {
      success: true;
      filters: TaskRunListSearchFilters;
      explanation?: string;
    }
  | {
      success: false;
      error: string;
      suggestions?: string[];
    };

export function AIFilterInput() {
  const [text, setText] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const inputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<AIFilterResult>();

  useEffect(() => {
    if (fetcher.data?.success && fetcher.state === "loading") {
      setText("");
      setIsFocused(false);

      const searchParams = objectToSearchParams(fetcher.data.filters);
      if (!searchParams) {
        return;
      }

      navigate(`${location.pathname}?${searchParams.toString()}`, { replace: true });

      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [fetcher.data, navigate]);

  const isLoading = fetcher.state === "submitting";

  return (
    <fetcher.Form
      className="flex items-center gap-2"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/ai-filter`}
      method="post"
    >
      <ErrorPopover error={fetcher.data?.success === false ? fetcher.data.error : undefined}>
        <motion.div
          initial={{ width: "auto" }}
          animate={{ width: isFocused && text.length > 0 ? "24rem" : "auto" }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
          }}
          className="relative h-6 min-w-44"
        >
          <AnimatePresence>
            {isFocused && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "linear" }}
                className="animated-gradient-glow-small pointer-events-none absolute inset-0 h-6"
              />
            )}
          </AnimatePresence>
          <div className="absolute inset-0 left-0 top-0 h-6">
            <Input
              type="text"
              name="text"
              variant="secondary-small"
              placeholder="Describe your filters…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={isLoading}
              fullWidth
              ref={inputRef}
              className={cn(
                "disabled:text-text-dimmed/50",
                isFocused && "placeholder:text-text-dimmed/70"
              )}
              containerClassName="has-[:disabled]:opacity-100"
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim() && !isLoading) {
                  e.preventDefault();
                  const form = e.currentTarget.closest("form");
                  if (form) {
                    form.requestSubmit();
                  }
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setText("");
                  e.currentTarget.blur();
                }
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => {
                if (text.length === 0 || !isLoading) {
                  setIsFocused(false);
                }
              }}
              icon={<AISparkleIcon className="size-4" />}
              accessory={
                isLoading ? (
                  <Spinner
                    color={{
                      background: "rgba(99, 102, 241, 1)",
                      foreground: "rgba(217, 70, 239, 1)",
                    }}
                    className="size-4 opacity-80"
                  />
                ) : text.length > 0 ? (
                  <div className="-mr-1 flex items-center gap-1.5">
                    <ShortcutKey
                      shortcut={{ key: "enter" }}
                      variant="medium"
                      className="border-none"
                    />
                    <SimpleTooltip
                      asChild
                      button={
                        <button
                          type="button"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            setText("");
                          }}
                          className="flex size-4.5 items-center justify-center rounded-[2px] border border-text-dimmed/40 text-text-dimmed transition hover:bg-charcoal-600 hover:text-text-bright"
                        >
                          <XMarkIcon className="size-3" />
                        </button>
                      }
                      content={
                        <div className="flex items-center gap-1">
                          <span className="text-text-dimmed">Clear field</span>
                          <ShortcutKey shortcut={{ key: "esc" }} variant="small" />
                        </div>
                      }
                      className="px-2 py-1.5 text-xs"
                      disableHoverableContent
                    />
                  </div>
                ) : undefined
              }
            />
          </div>
        </motion.div>
      </ErrorPopover>
    </fetcher.Form>
  );
}

function ErrorPopover({
  children,
  error,
  durationMs = 10_000,
}: {
  children: React.ReactNode;
  error?: string;
  durationMs?: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const timeout = useRef<NodeJS.Timeout | undefined>();

  useEffect(() => {
    if (error) {
      setIsOpen(true);
    }
    if (timeout.current) {
      clearTimeout(timeout.current);
    }
    timeout.current = setTimeout(() => {
      setIsOpen(false);
    }, durationMs);

    return () => {
      if (timeout.current) {
        clearTimeout(timeout.current);
      }
    };
  }, [error, durationMs]);

  return (
    <Popover open={isOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-trigger-width)] border border-error/20 bg-[#2F1D24] px-3 py-2 text-xs text-text-dimmed"
      >
        {error}
      </PopoverContent>
    </Popover>
  );
}
