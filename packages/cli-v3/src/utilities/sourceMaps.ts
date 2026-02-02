import sourceMapSupport from "source-map-support";

export function installSourceMapSupport() {
    const sourceMaps = process.env.TRIGGER_SOURCE_MAPS;

    if (sourceMaps === "false" || sourceMaps === "0") {
        return;
    }

    if (sourceMaps === "node") {
        if (process.setSourceMapsEnabled) {
            process.setSourceMapsEnabled(true);
        }
        return;
    }

    sourceMapSupport.install({
        handleUncaughtExceptions: false,
        environment: "node",
        hookRequire: false,
    });
}
