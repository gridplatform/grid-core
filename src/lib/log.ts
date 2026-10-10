/**
 * Pretty local timestamps for stdout logs (HTTP + console).
 * Plain text only — no ANSI (prod / Docker / IDE captures escape codes as \u001b).
 * Example: 2026-10-10 11:43:05.123
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Local wall-clock time — readable in operator terminals and log shippers. */
export function formatLogTimestamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

/** Alias kept for morgan / callers — always plain (no ANSI). */
export function formatLogTimestampStyled(d: Date = new Date()): string {
  return formatLogTimestamp(d);
}

declare global {
  // eslint-disable-next-line no-var
  var __gridConsoleTimestampsInstalled: boolean | undefined;
}

/**
 * Prefix every console.log / info / warn / error / debug with a timestamp.
 * Idempotent — safe to call from index + app.
 */
export function installConsoleTimestamps(): void {
  if (globalThis.__gridConsoleTimestampsInstalled) return;
  globalThis.__gridConsoleTimestampsInstalled = true;

  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(formatLogTimestamp(), ...args);
    };
  }
}
