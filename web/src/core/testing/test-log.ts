/** Shared test log: silent unless CORE_DEBUG=1 is set (then every entry is mirrored to the console). Test-only. */
import { createLog } from "../log.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export const testLog = createLog({ consoleLevel: env?.CORE_DEBUG ? "debug" : null });
