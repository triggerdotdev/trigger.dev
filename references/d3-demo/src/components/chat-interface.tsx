import { cn } from "@/lib/utils"

interface Message {
  role: "user" | "assistant"
  content: string
}

interface ChatInterfaceProps {
  messages: Message[]
}

export default function ChatInterface({ messages }: ChatInterfaceProps) {
  return (
    <div className="space-y-4 p-4">
      {messages.map((message, index) => (
        <div key={index} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
          <div
            className={cn(
              "max-w-[80%] rounded-lg p-3",
              message.role === "user"
                ? "bg-primary text-primary-foreground rounded-tr-none"
                : "bg-muted text-muted-foreground rounded-tl-none",
            )}
          >
            {message.content}
          </div>
        </div>
      ))}
    </div>
  )
}

