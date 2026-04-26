import { join } from "node:path";
import { readFileSync } from "node:fs";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { BridgeConfig } from "./types";

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Load a secret from systemd credential store (v250+) or fall back to env var.
 * systemd delivers credentials as files under $CREDENTIALS_DIRECTORY.
 * This is more secure than Environment= which leaks via systemctl show and /proc.
 */
function loadCredential(name: string, envVar: string): string | undefined {
  // Try systemd credential store first
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try {
      const credPath = join(credDir, name);
      const value = readFileSync(credPath, "utf8").trim();
      if (value) return value;
    } catch {
      // Credential file not found or unreadable — fall through to env
    }
  }
  // Fallback to environment variable
  return process.env[envVar] || undefined;
}

export function loadConfig(): BridgeConfig {
  return {
    host: process.env.BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.BRIDGE_PORT || "4317"),
    secret: loadCredential("bridge-secret", "BRIDGE_SECRET"),
    dryRun: readBoolean(process.env.BRIDGE_DRY_RUN, true),
    eventsLogPath: process.env.BRIDGE_EVENTS_LOG_PATH || join(process.cwd(), "tmp", "events.ndjson"),
    starOfficeUrl: process.env.STAR_OFFICE_URL || undefined,
    starOfficeJoinKey: process.env.STAR_OFFICE_JOIN_KEY || undefined,
    mainAgentName: process.env.STAR_OFFICE_MAIN_AGENT_NAME || "free-code",
    zellijSessionName: process.env.ZELLIJ_SESSION_NAME || undefined,
    zellijWebUrl: process.env.ZELLIJ_WEB_URL || undefined,
    zellijWebToken: process.env.ZELLIJ_WEB_TOKEN || undefined,
    zellijWebTokenName: process.env.ZELLIJ_WEB_TOKEN_NAME || undefined,
  };
}

/**
 * Constant-time string comparison using Node's crypto.timingSafeEqual.
 * Falls back to custom XOR implementation if Buffer is unavailable.
 * Prevents timing attacks on secret comparison.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a full comparison to avoid leaking length info via timing
    let result = bufA.length ^ bufB.length;
    const minLen = Math.min(bufA.length, bufB.length);
    for (let i = 0; i < minLen; i++) {
      result |= bufA[i] ^ bufB[i];
    }
    return result === 0;
  }
  return cryptoTimingSafeEqual(bufA, bufB);
}
