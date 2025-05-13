import { useState } from "react";

interface ChatInputProps {
  onSubmit: (input: string) => void;
  isSubmitting?: boolean;
}

export function ChatInput({ onSubmit, isSubmitting = false }: ChatInputProps) {
  const [input, setInput] = useState("");

  function handleSubmit() {
    if (!input.trim() || isSubmitting) return;
    onSubmit(input);
    setInput("");
  }

  return (
    <div className="flex items-center">
      <div className="flex-grow relative">
        <input
          type="text"
          placeholder="Type your message..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={isSubmitting}
        />
      </div>
      <button
        className="ml-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
        onClick={handleSubmit}
        disabled={isSubmitting || !input.trim()}
      >
        {isSubmitting ? "Sending..." : "Send"}
      </button>
    </div>
  );
}
