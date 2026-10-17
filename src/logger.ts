export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimumLevel: LogLevel = "info";

export function configureLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

export function log(
  level: LogLevel,
  component: string,
  message: string,
  fields: Record<string, unknown> = {}
): void {
  if (priorities[level] < priorities[minimumLevel]) return;
  const record = JSON.stringify({ at: new Date().toISOString(), level, component, message, ...fields });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
