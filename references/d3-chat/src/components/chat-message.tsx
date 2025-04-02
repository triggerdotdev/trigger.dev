import { Avatar } from "@/components/ui/avatar";
import ReactMarkdown from "react-markdown";
import { marked } from "marked";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  id: string;
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
}

const ParsedMarkdown = ({ content, id }: { content: string; id: string }) => {
  const blocks = parseMarkdownIntoBlocks(content);

  return blocks.map((block, index) => <ReactMarkdown key={index}>{block}</ReactMarkdown>);
};

export function ChatMessage({ role, content, id }: ChatMessageProps) {
  return (
    <div className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[80%] ${role === "user" ? "flex-row-reverse" : "flex-row"}`}>
        <div className="flex-shrink-0">
          <Avatar className="h-8 w-8">
            <div
              className={`flex h-full w-full items-center justify-center rounded-full ${
                role === "user" ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-600"
              }`}
            >
              {role === "user" ? "U" : "A"}
            </div>
          </Avatar>
        </div>

        <div className={`mx-2 ${role === "user" ? "text-right" : "text-left"}`}>
          <div className="text-xs text-gray-500 mb-1">{role === "user" ? "You" : "Assistant"}</div>
          <div
            className={`px-4 py-3 rounded-lg ${
              role === "user"
                ? "bg-blue-50 border border-blue-100 text-gray-800"
                : "bg-white border border-gray-200 text-gray-800"
            }`}
          >
            {role === "assistant" ? (
              <div className="prose prose-sm max-w-none prose-pre:bg-gray-800 prose-pre:text-gray-100">
                <ParsedMarkdown content={content} id={id} />
              </div>
            ) : (
              <div className="whitespace-pre-wrap text-sm">{content}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
