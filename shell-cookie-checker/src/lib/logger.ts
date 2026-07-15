// Minimal pino-compatible logger shim for the shell version.
// Outputs nothing by default; set VERBOSE=1 to see debug logs.

const VERBOSE = process.env["VERBOSE"] === "1";

type LogFn = (obj: unknown, msg?: string) => void;

interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child: (obj: Record<string, unknown>) => Logger;
}

function makeLogger(prefix = ""): Logger {
  const tag = prefix ? `[${prefix}] ` : "";
  return {
    debug: (obj, msg) => {
      if (VERBOSE) console.error(`DEBUG ${tag}${msg ?? ""}`, obj ?? "");
    },
    info: (obj, msg) => {
      if (VERBOSE) console.error(`INFO  ${tag}${msg ?? ""}`, obj ?? "");
    },
    warn: (obj, msg) => {
      if (VERBOSE) console.error(`WARN  ${tag}${msg ?? ""}`, obj ?? "");
    },
    error: (obj, msg) => {
      if (VERBOSE) console.error(`ERROR ${tag}${msg ?? ""}`, obj ?? "");
    },
    child: (bindings) => makeLogger(bindings["module"] as string ?? prefix),
  };
}

export const logger = makeLogger();
