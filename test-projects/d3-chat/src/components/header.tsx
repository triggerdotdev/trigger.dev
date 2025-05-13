export function Header() {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <span className="font-mono text-lg font-semibold">Todo Chat</span>
          <span className="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded">v1.0.0</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="text-sm text-gray-500">user_123456</div>
        </div>
      </div>
    </header>
  )
}

