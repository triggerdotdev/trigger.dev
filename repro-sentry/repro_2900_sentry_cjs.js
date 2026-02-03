
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
            console.log("[Interceptor] Restoring console...");
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
            defaultIntegrations: true,
        });
    } catch (e) {
        console.error("Sentry init failed:", e);
    }

    console.log("3. Verifying Sentry patch (this log should go through Sentry)");

    console.log("4. Executor: Starting task execution (calling intercept)");
    await interceptor.intercept(console, async () => {
        console.log("5. Inside Interceptor: This should be captured by OTEL AND Sentry?");

        await new Promise(r => setTimeout(r, 100));

        console.log("6. Inside Interceptor: Still working?");
    });

    console.log("7. After Interceptor: Restored. This should go through Sentry again.");
}

run().catch(console.error);
