import { useCallback, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Input } from "~/components/primitives/Input";
import { RunTag } from "./RunTag";

interface TagInputProps {
  id?: string; // used for the hidden input for form submission
  name?: string; // used for the hidden input for form submission
  defaultTags?: string[];
  placeholder?: string;
  variant?: "small" | "medium";
  onTagsChange?: (tags: string[]) => void;
}

export function RunTagInput({
  id,
  name,
  defaultTags = [],
  placeholder = "Type and press Enter to add tags",
  variant = "small",
  onTagsChange,
}: TagInputProps) {
  const [tags, setTags] = useState<string[]>(defaultTags);
  const [inputValue, setInputValue] = useState("");

  const addTag = useCallback(
    (tagText: string) => {
      const trimmedTag = tagText.trim();
      if (trimmedTag && !tags.includes(trimmedTag)) {
        const newTags = [...tags, trimmedTag];
        setTags(newTags);
        onTagsChange?.(newTags);
      }
      setInputValue("");
    },
    [tags, onTagsChange]
  );

  const removeTag = useCallback(
    (tagToRemove: string) => {
      const newTags = tags.filter((tag) => tag !== tagToRemove);
      setTags(newTags);
      onTagsChange?.(newTags);
    },
    [tags, onTagsChange]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addTag(inputValue);
      } else if (e.key === "Backspace" && inputValue === "" && tags.length > 0) {
        removeTag(tags[tags.length - 1]);
      }
    },
    [inputValue, addTag, removeTag, tags]
  );

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} id={id} value={tags.join(",")} />

      <Input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        variant={variant}
      />

      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <AnimatePresence mode="popLayout">
            {tags.map((tag, i) => (
              <motion.div
                key={tag}
                initial={{
                  opacity: 0,
                  scale: 0.8,
                }}
                animate={{
                  opacity: 1,
                  scale: 1,
                }}
                exit={{
                  opacity: 0,
                  scale: 0.7,
                  y: -10,
                  transition: {
                    duration: 0.15,
                    ease: "easeOut",
                  },
                }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 25,
                  duration: 0.15,
                }}
              >
                <RunTag tag={tag} action={{ type: "delete", onDelete: removeTag }} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
