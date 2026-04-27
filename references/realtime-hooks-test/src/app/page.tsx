import {
  triggerSimpleTask,
  triggerStreamTask,
  triggerTaggedTask,
  triggerBatchTasks,
  triggerStreamOnlyTask,
} from "./actions";

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="font-semibold leading-none tracking-tight">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="p-6 pt-0 space-y-4">
        {children}
      </div>
    </div>
  );
}

function Button({ children, variant = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "secondary" | "outline" }) {
  const variants = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
  };
  
  return (
    <button 
      className={`inline-flex w-full items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-9 px-4 py-2 ${variants[variant]}`}
      {...props}
    >
      {children}
    </button>
  );
}

export default function Home() {
  return (
    <div className="space-y-8">
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* useRealtimeRun */}
        <Card title="useRealtimeRun" description="Single task run subscription">
          <form action={async () => {
            "use server";
            await triggerSimpleTask("Quick test run", 5);
          }}>
            <Button type="submit">Run (5s)</Button>
          </form>
          <form action={async () => {
            "use server";
            await triggerSimpleTask("Longer test run", 15);
          }}>
            <Button type="submit" variant="secondary">Run (15s)</Button>
          </form>
        </Card>

        {/* useRealtimeRunWithStreams */}
        <Card title="useRealtimeRunWithStreams" description="Run subscription with streams">
          <div className="grid grid-cols-1 gap-2">
            <form action={async () => {
              "use server";
              await triggerStreamTask("text", 20);
            }}>
              <Button type="submit" variant="outline">Text Stream</Button>
            </form>
            <form action={async () => {
              "use server";
              await triggerStreamTask("json", 20);
            }}>
              <Button type="submit" variant="outline">JSON Stream</Button>
            </form>
            <form action={async () => {
              "use server";
              await triggerStreamTask("mixed", 30);
            }}>
              <Button type="submit" variant="outline">Mixed Streams</Button>
            </form>
          </div>
        </Card>

        {/* useRealtimeRunsWithTag */}
        <Card title="useRealtimeRunsWithTag" description="Subscribe to runs by tag">
          <form action={async () => {
            "use server";
            await triggerTaggedTask("user-123", "process-order", ["order-processing", "user-123"]);
          }}>
            <Button type="submit" className="border-l-4 border-l-emerald-500">Tag: order-processing</Button>
          </form>
          <form action={async () => {
            "use server";
            await triggerTaggedTask("user-456", "send-email", ["notifications", "user-456"]);
          }}>
            <Button type="submit" className="border-l-4 border-l-blue-500" variant="secondary">Tag: notifications</Button>
          </form>
        </Card>

        {/* useRealtimeBatch */}
        <Card title="useRealtimeBatch" description="Batch run monitoring">
          <div className="grid grid-cols-3 gap-2">
            <form action={async () => {
              "use server";
              await triggerBatchTasks(5);
            }}>
              <Button type="submit" variant="outline">5</Button>
            </form>
            <form action={async () => {
              "use server";
              await triggerBatchTasks(10);
            }}>
              <Button type="submit" variant="outline">10</Button>
            </form>
            <form action={async () => {
              "use server";
              await triggerBatchTasks(20);
            }}>
              <Button type="submit" variant="outline">20</Button>
            </form>
          </div>
        </Card>

        {/* useRealtimeStream */}
        <Card title="useRealtimeStream" description="Direct stream subscription">
          <form action={async () => {
            "use server";
            await triggerStreamOnlyTask();
          }}>
            <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white">Start Stream</Button>
          </form>
        </Card>
      </div>

      <div className="rounded-lg bg-secondary/50 p-4 text-sm text-muted-foreground font-mono">
        <p>Test environment ready. Click any trigger to start a session.</p>
      </div>
    </div>
  );
}
