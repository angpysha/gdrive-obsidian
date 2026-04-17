export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const MAX = 300;
const entries: LogEntry[] = [];

export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, msg };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  console[level]("[GDriveSync]", msg);
}

export function getLogs(): readonly LogEntry[] {
  return entries;
}

export function clearLogs(): void {
  entries.length = 0;
}

export function formatLogs(): string {
  return entries
    .map((e) => {
      const d = new Date(e.ts);
      const t = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
      return `[${t}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
    })
    .join("\n");
}
