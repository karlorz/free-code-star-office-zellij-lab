import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeConfig, BridgeErrorInfo, BridgeEventLogEntry } from "./types";

export const EVENTS_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const EVENTS_LOG_KEEP_ROTATED = 2;

let _logSink: ReturnType<typeof Bun.file> extends { writer(...args: any[]): infer W } ? W : never;
let _logSinkPath = "";

export function getLogSink(config: BridgeConfig) {
  if (!_logSink || _logSinkPath !== config.eventsLogPath) {
    _logSinkPath = config.eventsLogPath;
    _logSink = Bun.file(config.eventsLogPath).writer();
  }
  return _logSink;
}

export async function flushLogSink() {
  try { _logSink?.flush(); } catch { /* sink may be closed after rotation */ }
}

export async function closeLogSink() {
  try { _logSink?.end(); } catch { /* already closed */ }
  _logSink = undefined as any;
  _logSinkPath = "";
}

export function formatError(error: unknown): BridgeErrorInfo {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export async function appendEvent(
  entry: BridgeEventLogEntry,
  config: BridgeConfig,
  backgroundProcs: Bun.Subprocess[],
): Promise<void> {
  try {
    await mkdir(dirname(config.eventsLogPath), { recursive: true });
    try {
      const fileStat = await stat(config.eventsLogPath);
      if (fileStat.size > EVENTS_LOG_MAX_BYTES) {
        console.log(`[bridge] rotating events log (${(fileStat.size / 1024 / 1024).toFixed(1)}MB exceeds ${EVENTS_LOG_MAX_BYTES / 1024 / 1024}MB limit)`);
        await closeLogSink();
        const { rename: renameFile } = await import("node:fs/promises");
        for (let i = EVENTS_LOG_KEEP_ROTATED; i >= 1; i--) {
          const rotatedPath = `${config.eventsLogPath}.${i}`;
          const rotatedZstPath = `${rotatedPath}.zst`;
          const nextRotatedPath = `${config.eventsLogPath}.${i + 1}`;
          const nextRotatedZstPath = `${nextRotatedPath}.zst`;
          try {
            const hasZst = await stat(rotatedZstPath).then(() => true).catch(() => false);
            const hasPlain = await stat(rotatedPath).then(() => true).catch(() => false);
            if (i === EVENTS_LOG_KEEP_ROTATED) {
              if (hasZst) await unlink(rotatedZstPath);
              if (hasPlain) await unlink(rotatedPath);
            } else {
              if (hasZst) await renameFile(rotatedZstPath, nextRotatedZstPath);
              if (hasPlain) await renameFile(rotatedPath, nextRotatedPath);
            }
          } catch { /* file doesn't exist */ }
        }
        await renameFile(config.eventsLogPath, `${config.eventsLogPath}.1`);
        const zstSrc = `${config.eventsLogPath}.1`;
        const zstProc = Bun.spawn({ cmd: ["zstd", "-3", "--rm", zstSrc], stderr: "ignore", onExit(proc, exitCode) {
          if (exitCode !== 0) console.warn(`[bridge] zstd compression failed for ${zstSrc}: exit=${exitCode}`);
          const idx = backgroundProcs.indexOf(zstProc);
          if (idx >= 0) backgroundProcs.splice(idx, 1);
        } });
        backgroundProcs.push(zstProc);
      }
    } catch {
      // File doesn't exist yet — no rotation needed
    }
    const sink = getLogSink(config);
    sink.write(`${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn("[bridge] failed to append event", formatError(error));
  }
}

export async function appendIgnoredEvent(
  source: string,
  ignoreReason: string,
  options: {
    rawEvent?: unknown;
    rawBody?: string;
    sseEventSeq?: number | null;
  },
  config: BridgeConfig,
  metrics: { signalsSuppressed: number },
): Promise<void> {
  metrics.signalsSuppressed++;
  const entry: BridgeEventLogEntry = {
    source,
    receivedAt: new Date().toISOString(),
    sseEventSeq: options.sseEventSeq ?? null,
    rawEvent: options.rawEvent ?? null,
    signal: null,
    originalSignal: null,
    starOfficeResult: null,
    starOfficeError: null,
    ignored: true,
    ignoreReason,
    rawBody: options.rawBody,
  };
  await appendEvent(entry, config, []);
}
