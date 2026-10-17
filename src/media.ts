import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DiscTitle } from "./model.js";
import { runProcess } from "./process.js";

const makeMkv = process.env.MAKEMKV_COMMAND ?? "makemkvcon";

function unquote(value: string): string {
  return value.replace(/^"/, "").replace(/"$/, "").replace(/""/g, '"').trim();
}

function durationSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
}

export interface DiscInfo {
  label: string;
  titles: DiscTitle[];
}

export async function inspectDisc(device: string, signal?: AbortSignal): Promise<DiscInfo> {
  const result = await runProcess(makeMkv, ["--robot", "--noscan", "info", device], {
    timeoutMs: 120_000,
    ...(signal ? { signal } : {})
  });
  const titleValues = new Map<number, { name: string; durationSeconds: number }>();
  let label = "";
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.match(/^(CINFO|TINFO):(\d+),(\d+),\d+,(.*)$/);
    if (!fields) continue;
    const kind = fields[1];
    const itemId = Number(fields[2]);
    const attributeId = Number(fields[3]);
    const value = unquote(fields[4] ?? "");
    if (kind === "CINFO" && attributeId === 2) label = value;
    if (kind !== "TINFO") continue;
    const current = titleValues.get(itemId) ?? { name: "", durationSeconds: 0 };
    if (attributeId === 2) current.name = value;
    if (attributeId === 9) current.durationSeconds = durationSeconds(value);
    titleValues.set(itemId, current);
  }
  const titles = [...titleValues.entries()]
    .map(([id, value]) => ({ id, name: value.name, durationSeconds: value.durationSeconds }))
    .filter((title) => title.durationSeconds > 0);
  return { label, titles };
}

export async function ripTitle(device: string, titleId: number, workDir: string, signal?: AbortSignal): Promise<string> {
  const ripDir = join(workDir, `rip-${randomUUID()}`);
  await mkdir(ripDir, { recursive: true, mode: 0o750 });
  await runProcess(makeMkv, ["--robot", "--noscan", "mkv", device, String(titleId), ripDir], {
    timeoutMs: 8 * 60 * 60 * 1000,
    ...(signal ? { signal } : {})
  });
  const files = await readdir(ripDir);
  const candidates = await Promise.all(files
    .filter((file) => extname(file).toLowerCase() === ".mkv")
    .map(async (file) => ({ path: join(ripDir, file), size: (await stat(join(ripDir, file))).size })));
  candidates.sort((a, b) => b.size - a.size);
  if (candidates[0] === undefined) throw new Error("MakeMKV completed without producing a Matroska file");
  return candidates[0].path;
}

export async function ejectDisc(device: string): Promise<void> {
  await runProcess(process.env.EJECT_COMMAND ?? "eject", [device], { timeoutMs: 15_000 });
}

export function safeTitle(input: string): string {
  const safe = basename(input.trim().replace(/\\/g, "/"))
    .replace(/\.(mkv|mp4|avi|mpeg|mpg)$/i, "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ._()\-]+/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[ ._-]+|[ ._-]+$/g, "")
    .slice(0, 150);
  return safe || `Unknown Title ${new Date().toISOString().slice(0, 10)}`;
}
