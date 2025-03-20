import { useMemo } from "react";
import tagLeftPath from "./tag-left.svg";

type Tag = string | { key: string; value: string };

export function RunTag({ tag }: { tag: string }) {
  const tagResult = useMemo(() => splitTag(tag), [tag]);

  if (typeof tagResult === "string") {
    return (
      <span className="flex h-6 items-stretch">
        <img src={tagLeftPath} alt="" className="block h-full w-[0.5625rem]" />
        <span className="flex items-center rounded-r-sm border-y border-r border-charcoal-700 bg-charcoal-800 pr-1.5 text-text-dimmed">
          {tag}
        </span>
      </span>
    );
  } else {
    return (
      <span className="flex h-6 items-stretch">
        <img src={tagLeftPath} alt="" className="block h-full w-[0.5625rem]" />
        <span className="flex items-center border-y border-r border-charcoal-700 bg-charcoal-800 pr-1.5 text-text-dimmed">
          {tagResult.key}
        </span>
        <span className="flex items-center whitespace-nowrap rounded-r-sm border-y border-r border-charcoal-700 bg-charcoal-750 px-1.5 text-text-dimmed">
          {tagResult.value}
        </span>
      </span>
    );
  }
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
  const hasSpecialFormatChars = value.includes("-") || 
                                value.includes("T") || 
                                value.includes("Z") || 
                                value.includes("/");
  const isSpecialFormat = isAlphabeticKey && hasSpecialFormatChars;
  
  if (isSpecialFormat) return { key, value };
  
  return tag;
}
