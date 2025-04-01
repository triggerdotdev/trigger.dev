import { Avatar } from "@/components/ui/avatar"

interface ChatMessageProps {
  role: "user" | "assistant"
  content: string
}

export function ChatMessage({ role, content }: ChatMessageProps) {
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
            <div className="whitespace-pre-wrap text-sm">{content}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

