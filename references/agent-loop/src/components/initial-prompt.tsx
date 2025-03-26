export default function InitialPrompt() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center p-4">
      <h1 className="text-2xl font-bold mb-2">Welcome to the Chatbot</h1>
      <p className="text-muted-foreground mb-6">Start a conversation by typing a message below.</p>
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
        <span className="text-2xl">💬</span>
      </div>
      <p className="text-sm text-muted-foreground max-w-md">
        This is a simulated chatbot interface. Your messages will receive automated responses.
      </p>
    </div>
  )
}

