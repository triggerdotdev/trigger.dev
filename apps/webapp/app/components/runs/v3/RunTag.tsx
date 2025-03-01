import { Link } from "@remix-run/react";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import tagLeftPath from "./tag-left.svg";

type Tag = string | { key: string; value: string };

/** Takes a string and turns it into a tag
 *
 * If the string has 12 or fewer alpha characters followed by an underscore or colon then we return an object with a key and value
 * Otherwise we return the original string
 */
function splitTag(tag: string): Tag {
  if (tag.match(/^[a-zA-Z]{1,12}[_:]/)) {
    const components = tag.split(/[_:]/);
    if (components.length !== 2) {
      return tag;
    }
    return { key: components[0], value: components[1] };
  }

  return tag;
}

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
        <Link to={to} className="group">
          <span className="flex h-6 items-stretch">{renderTagContent()}</span>
        </Link>
      }
      content={tooltip || `Filter runs by ${tag}`}
      disableHoverableContent
    />
  ) : (
    <span className="flex h-6 items-stretch">{renderTagContent()}</span>
  );

  return (
    <div
      className="group relative inline-flex"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
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
        <button
          onClick={copy}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute -right-6 top-0 z-10 flex size-6 items-center justify-center rounded-r-sm border-y border-r border-charcoal-650 bg-charcoal-750",
            isHovered ? "opacity-100" : "opacity-0",
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
        </button>
      }
      content={copied ? "Copied!" : "Copy tag"}
      disableHoverableContent
    />
  );
}
