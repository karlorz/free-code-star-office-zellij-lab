import { timingSafeCompare } from "./config";
import type { BridgeConfig } from "./types";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, X-Bridge-Secret",
};

const rateLimits = new Map<string, { count: number; windowStart: number }>();
export const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 120;

export function isAuthorized(request: Request, config: BridgeConfig): boolean {
  if (!config.secret) {
    return true;
  }
  const provided = request.headers.get("x-bridge-secret");
  if (provided) {
    return timingSafeCompare(provided, config.secret);
  }
  return false;
}

export function checkRateLimit(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return null;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return ip;
  }
  return null;
}
