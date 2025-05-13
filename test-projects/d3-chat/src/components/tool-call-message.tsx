interface ToolCallMessageProps {
  name: string;
  input: any;
  output?: any;
}

export function ToolCallMessage({ name, input, output }: ToolCallMessageProps) {
  const hasOutput = output !== undefined;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[90%] bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
        <div className="bg-gray-100 px-4 py-2 flex items-center">
          <div className="flex items-center">
            <span
              className={`h-3 w-3 rounded-full mr-2 ${
                hasOutput ? "bg-green-500" : "bg-yellow-500 animate-pulse"
              }`}
            ></span>
            <span className="font-mono text-sm font-medium text-gray-700">{name}</span>
          </div>
          <span className="ml-2 text-xs text-gray-500">
            Tool Call {!hasOutput && "(Running...)"}
          </span>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1">Input</div>
            <pre className="bg-gray-800 text-gray-200 p-3 rounded text-xs overflow-x-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {hasOutput ? (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">Output</div>
              <pre className="bg-gray-800 text-gray-200 p-3 rounded text-xs overflow-x-auto">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="flex items-center space-x-2 text-sm text-gray-500">
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              <span>Waiting for result...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
