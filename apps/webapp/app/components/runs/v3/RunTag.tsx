import { useCallback, useMemo, useState } from "react";
import tagLeftPath from "./tag-left.svg";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";

type Tag = string | { key: string; value: string };

export function RunTag({ tag, to, tooltip }: { tag: string; to?: string; tooltip?: string }) {
  const tagResult = useMemo(() => splitTag(tag), [tag]);
  const [isHovered, setIsHovered] = useState(false);

  // Render the basic tag content
  const renderTagContent = () => {
    if (typeof tagResult === "string") {
      return (
        <>
          <img src={tagLeftPath} alt="" className="block h-full w-[0.5625rem]" />
          <span className="flex items-center rounded-r-sm border-y border-r border-charcoal-700 bg-charcoal-800 pr-1.5 text-text-dimmed group-hover:rounded-r-none group-has-[[href]]:group-hover:border-charcoal-650 group-has-[[href]]:group-hover:text-charcoal-300">
            {tag}
          </span>
        </>
      );
    } else {
      return (
        <>
          <img src={tagLeftPath} alt="" className="block h-full w-[0.5625rem]" />
          <span className="flex items-center border-y border-r border-charcoal-700 bg-charcoal-800 pr-1.5 text-text-dimmed group-has-[[href]]:group-hover:border-charcoal-650 group-has-[[href]]:group-hover:text-charcoal-300">
            {tagResult.key}
          </span>
          <span className="flex items-center whitespace-nowrap rounded-r-sm border-y border-r border-charcoal-700 bg-charcoal-750 px-1.5 text-text-dimmed group-hover:rounded-r-none group-has-[[href]]:group-hover:border-charcoal-650 group-has-[[href]]:group-hover:bg-charcoal-700 group-has-[[href]]:group-hover:text-charcoal-300">
            {tagResult.value}
          </span>
        </>
      );
    }
  };

  // The main tag content, optionally wrapped in a Link and SimpleTooltip
  const tagContent = to ? (
    <SimpleTooltip
      button={
        <Link to={to} className="group shrink-0" onMouseEnter={() => setIsHovered(true)}>
          <span className="flex h-6 items-stretch">{renderTagContent()}</span>
        </Link>
      }
      content={tooltip || `Filter by ${tag}`}
      disableHoverableContent
    />
  ) : (
    <span className="flex h-6 shrink-0 items-stretch" onMouseEnter={() => setIsHovered(true)}>
      {renderTagContent()}
    </span>
  );

  return (
    <div className="group relative inline-flex shrink-0" onMouseLeave={() => setIsHovered(false)}>
      {tagContent}
      <CopyButton textToCopy={tag} isHovered={isHovered} />
    </div>
  );
}

function CopyButton({ textToCopy, isHovered }: { textToCopy: string; isHovered: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [textToCopy]
  );

  return (
    <SimpleTooltip
      button={
        <span
          onClick={copy}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute -right-6 top-0 z-10 size-6 items-center justify-center rounded-r-sm border-y border-r border-charcoal-650 bg-charcoal-750",
            isHovered ? "flex" : "hidden",
            copied
              ? "text-green-500"
              : "text-text-dimmed hover:border-charcoal-600 hover:bg-charcoal-700 hover:text-text-bright"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
        </span>
      }
      content={copied ? "Copied!" : "Copy tag"}
      disableHoverableContent
    />
  );
}

/** Takes a string and turns it into a tag
 *
 * If the string has 12 or fewer alpha characters followed by an underscore or colon then we return an object with a key and value
 * Otherwise we return the original string
 *
 * Special handling for common ID formats and values with special characters.
 */
export function splitTag(tag: string): Tag {
  const match = tag.match(/^([a-zA-Z0-9]{1,12})[_:](.*?)$/);
  if (!match) return tag;

  const [, key, value] = match;

  const colonCount = (tag.match(/:/g) || []).length;
  const underscoreCount = (tag.match(/_/g) || []).length;

  const hasMultipleColons = colonCount > 1 && !tag.includes("_");
  const hasMultipleUnderscores = underscoreCount > 1 && !tag.includes(":");
  const isLikelyID = hasMultipleColons || hasMultipleUnderscores;

  if (!isLikelyID) return { key, value };

  const isAlphabeticKey = key.match(/^[a-zA-Z]+$/) !== null;
  const hasSpecialFormatChars =
    value.includes("-") || value.includes("T") || value.includes("Z") || value.includes("/");
  const isSpecialFormat = isAlphabeticKey && hasSpecialFormatChars;

  if (isSpecialFormat) return { key, value };

  return tag;
}
