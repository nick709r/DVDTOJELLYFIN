import { link, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppSettings, EncoderResult } from "./model.js";
import { runProcess } from "./process.js";
import { log } from "./logger.js";

const ffmpeg = process.env.FFMPEG_COMMAND ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_COMMAND ?? "ffprobe";

export async function availableEncoders(signal?: AbortSignal): Promise<{ nvidia: boolean; software: boolean }> {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-encoders"], {
    timeoutMs: 20_000,
    ...(signal ? { signal } : {})
  });
  return {
    nvidia: /\bh264_nvenc\b/.test(result.stdout),
    software: /\blibx264\b/.test(result.stdout)
  };
}

async function probeNvenc(signal?: AbortSignal): Promise<boolean> {
  try {
    await runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1",
      "-frames:v", "1", "-an", "-c:v", "h264_nvenc",
      "-f", "null", "-"
    ], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
    return true;
  } catch {
    if (signal?.aborted) throw new Error("Encoder probe cancelled");
    return false;
  }
}

export async function selectEncoder(choice: AppSettings["encoder"], signal?: AbortSignal): Promise<EncoderResult> {
  const available = await availableEncoders(signal);
  const nvencUsable = available.nvidia && await probeNvenc(signal);
  if (choice !== "software" && nvencUsable) {
    return { name: "NVIDIA NVENC (h264_nvenc)", codec: "h264_nvenc", hardware: true };
  }
  if (choice === "nvidia" && !nvencUsable) {
    log("warn", "encoder", "NVIDIA NVENC requested but unavailable; falling back to software encoding");
  }
  if (available.software) return { name: "FFmpeg libx264 (software)", codec: "libx264", hardware: false };
  throw new Error("No usable H.264 encoder found in this FFmpeg build");
}

export async function mediaDuration(file: string, signal?: AbortSignal): Promise<number> {
  const result = await runProcess(ffprobe, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file
  ], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("FFprobe could not determine input duration");
  return duration;
}

function parseClock(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
}

export async function convert(
  input: string,
  target: string,
  title: string,
  settings: AppSettings,
  onPublishing: (encoder: EncoderResult) => void,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<{ encoder: EncoderResult; outputBytes: number }> {
  const duration = await mediaDuration(input, signal);
  const encoder = await selectEncoder(settings.encoder, signal);
  const temporary = join(
    dirname(target),
    `.autodisc-${randomUUID()}${extname(target)}`
  );
  await mkdir(dirname(target), { recursive: true });
  const argsFor = (selected: EncoderResult): string[] => [
    "-hide_banner", "-nostdin", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", selected.codec,
    ...(selected.hardware
      ? ["-preset", settings.preset === "ultrafast" ? "p1" : settings.preset === "medium" ? "p5" : "p4", "-rc", "vbr", "-cq", String(settings.quality), "-b:v", "0"]
      : ["-preset", settings.preset, "-crf", String(settings.quality)]),
    "-c:a", "aac", "-b:a", "192k",
    "-metadata", `title=${title}`,
    ...(settings.format === "mp4" ? ["-movflags", "+faststart"] : []),
    "-progress", "pipe:1", "-nostats",
    temporary
  ];
  const reportProgress = (line: string): void => {
    const [key, value] = line.split("=", 2);
    if (key === "out_time") onProgress(Math.min(0.99, parseClock(value ?? "") / duration));
  };

  try {
    let usedEncoder = encoder;
    try {
      await runProcess(ffmpeg, argsFor(usedEncoder), {
        timeoutMs: 8 * 60 * 60 * 1000,
        onStdoutLine: reportProgress,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (!encoder.hardware || signal?.aborted) throw error;
      await unlink(temporary).catch(() => undefined);
      usedEncoder = { name: "FFmpeg libx264 (software fallback)", codec: "libx264", hardware: false };
      await runProcess(ffmpeg, argsFor(usedEncoder), {
        timeoutMs: 8 * 60 * 60 * 1000,
        onStdoutLine: reportProgress,
        ...(signal ? { signal } : {})
      });
    }
    const info = await stat(temporary);
    if (info.size < 1024) throw new Error("FFmpeg output is unexpectedly small");
    await mediaDuration(temporary, signal);
    onPublishing(usedEncoder);
    await link(temporary, target);
    await unlink(temporary);
    onProgress(1);
    return { encoder: usedEncoder, outputBytes: info.size };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
