
const Sentry = require("@sentry/node");

// Mock ConsoleInterceptor (simplified)
class MockConsoleInterceptor {
    constructor() {
        this.intercepting = false;
        this.interceptedMethods = {};
    }

    async intercept(consoleObj, callback) {
        console.log("[Interceptor] Starting interception...");

        const originalConsole = {
            log: consoleObj.log,
            info: consoleObj.info,
            warn: consoleObj.warn,
            error: consoleObj.error,
        };

        this.interceptedMethods = originalConsole;

        // Override
        consoleObj.log = (...args) => {
            process.stdout.write(`[OTEL LOG] ${args.join(" ")}\n`);
        };

        try {
            return await callback();
        } finally {
            process.stdout.write("[Interceptor] Restoring console...\n");
            consoleObj.log = originalConsole.log;
            consoleObj.info = originalConsole.info;
            consoleObj.warn = originalConsole.warn;
            consoleObj.error = originalConsole.error;
        }
    }
}

async function run() {
    console.log("1. Bootstrap: Creating ConsoleInterceptor");
    const interceptor = new MockConsoleInterceptor();

    console.log("2. Loading init.ts (Simulated): Initializing Sentry");
    try {
        Sentry.init({
            dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
            // Remove defaultIntegrations: true if not needed or verify correct usage for v8. 
            // For v8, default integrations are added automatically.
        });
    } catch (e) {
        console.error("Sentry init failed:", e);
    }

    console.log("3. Verifying Sentry patch (this log should go through Sentry)");

    console.log("4. Executor: Starting task execution (calling intercept)");
    await interceptor.intercept(console, async () => {
        console.log("5. Inside Interceptor: This should be captured by OTEL AND Sentry?");

        // Simulate Sentry intercepting AFTER we intercepted?
        // In real scenario, Sentry is init'd in `bootstrap` (global scope), but maybe it patches console lazily?
        // OR, if the user calls Sentry.init() inside the task or init.ts which happens inside intercept?

        // Let's simulate user calling Sentry.init AGAIN inside the task (e.g. init.ts hook)
        console.log("--> User calls Sentry.init() inside task...");
        try {
            // This mimics what happens if init.ts runs inside the interceptor context
            // But wait, the issue says init.ts is loaded.
            // If init.ts is imported inside `bootstrap` -> `importConfig` -> `lifecycleHooks`
            // `taskExecutor` calls `intercept`
            // `intercept` calls `try { callback() }`
            // callback calls `lifecycleHooks.callInitHooks` -> executing user's init code.
            // IF user's init code calls Sentry.init() (or Sentry.something that patches console),
            // THEN Sentry patches ON TOP of Interceptor.

            // Let's force a console patch simulation here to match that hypothesis
            const currentLog = console.log;
            console.log = (...args) => {
                process.stdout.write(`[SENTRY LOG] ${args.join(" ")}\n`);
                // Sentry typically calls the "wrapped" function if it exists.
                if (currentLog) currentLog.apply(console, args);
            };
        } catch (e) { }

        console.log("6. Inside Interceptor (Post-Sentry-Patch): Still working?");

        await new Promise(r => setTimeout(r, 100));
    });

    console.log("7. After Interceptor: Restored. This should go through Sentry again.");
}

run().catch(console.error);
