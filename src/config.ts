import { join } from "node:path";
import type { BridgeConfig } from "./types";

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(): BridgeConfig {
  return {
    host: process.env.BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.BRIDGE_PORT || "4317"),
    secret: process.env.BRIDGE_SECRET || undefined,
    dryRun: readBoolean(process.env.BRIDGE_DRY_RUN, true),
    eventsLogPath: process.env.BRIDGE_EVENTS_LOG_PATH || join(process.cwd(), "tmp", "events.ndjson"),
    starOfficeUrl: process.env.STAR_OFFICE_URL || undefined,
    starOfficeJoinKey: process.env.STAR_OFFICE_JOIN_KEY || undefined,
    mainAgentName: process.env.STAR_OFFICE_MAIN_AGENT_NAME || "free-code",
    zellijSessionName: process.env.ZELLIJ_SESSION_NAME || undefined,
  };
}
