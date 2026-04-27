// TypeScript translation of posthog/hogql/timings.py

/**
 * Get performance counter in milliseconds (Node.js equivalent of perf_counter)
 * Uses performance.now() which is available in:
 * - Node.js 18+ (global)
 * - Browser (global)
 * - Node.js <18 via perf_hooks module
 */
function getPerformanceNow(): number {
    // Check for global performance (Node.js 18+ or browser)
    if (typeof globalThis !== 'undefined' && 'performance' in globalThis) {
        const perf = (globalThis as any).performance;
        if (perf && typeof perf.now === 'function') {
            return perf.now();
        }
    }
    
    // Fallback to Date.now() if performance API is not available
    // Note: This is less precise but works everywhere
    return Date.now();
}

export interface QueryTiming {
    key: string; // Key identifying the timing measurement
    time: number; // Time in seconds
}

const TIMING_DECIMAL_PLACES = 3; // round to milliseconds

// Not thread safe.
// See trends_query_runner for an example of how to use for multithreaded queries
export class TSQLTimings {
    // Completed time in seconds for different parts of the TSQL query
    timings: Record<string, number> = {};

    // Used for housekeeping
    private _timingPointer: string;
    private _timingStarts: Record<string, number> = {};

    constructor(_timingPointer: string = '.') {
        this._timingPointer = _timingPointer;
        this._timingStarts[this._timingPointer] = this.perfCounter();
    }

    cloneForSubquery(seriesIndex: number): TSQLTimings {
        return new TSQLTimings(`${this._timingPointer}/series_${seriesIndex}`);
    }

    clearTimings(): void {
        this.timings = {};
    }

    /**
     * Measure execution time of a function.
     * Usage: timings.measure('operation', () => { ... });
     */
    measure<T>(key: string, fn: () => T): T {
        const lastKey = this._timingPointer;
        const fullKey = `${this._timingPointer}/${key}`;
        this._timingPointer = fullKey;
        this._timingStarts[fullKey] = this.perfCounter();

        try {
            return fn();
        } finally {
            const duration = (this.perfCounter() - this._timingStarts[fullKey]) / 1000; // Convert to seconds
            this.timings[fullKey] = (this.timings[fullKey] || 0.0) + duration;
            delete this._timingStarts[fullKey];
            this._timingPointer = lastKey;
        }
    }

    /**
     * Get performance counter in milliseconds (Node.js equivalent of perf_counter)
     */
    private perfCounter(): number {
        return getPerformanceNow();
    }

    toDict(): Record<string, number> {
        const timings = { ...this.timings };
        // Process in reverse order to handle nested timings correctly
        const keys = Object.keys(this._timingStarts).reverse();
        for (const key of keys) {
            const start = this._timingStarts[key];
            const elapsed = (this.perfCounter() - start) / 1000; // Convert to seconds
            timings[key] = this.round((timings[key] || 0.0) + elapsed);
        }
        return timings;
    }

    toList(backOutStack: boolean = true): QueryTiming[] {
        const timingDict = backOutStack ? this.toDict() : this.timings;
        return Object.entries(timingDict).map(([key, time]) => ({
            key: key,
            time: this.round(time),
        }));
    }

    /**
     * Round to specified decimal places (milliseconds precision)
     */
    private round(value: number): number {
        return Math.round(value * Math.pow(10, TIMING_DECIMAL_PLACES)) / Math.pow(10, TIMING_DECIMAL_PLACES);
    }
}
