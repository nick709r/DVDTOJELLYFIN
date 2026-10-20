import type { ClassificationAuditRecord } from "../domain/classification.js";

const LABELS: Record<string, string> = {
  dvd: "DVD", bluray: "Blu-ray", audio_cd: "CD Audio", cdrom: "CD-ROM", mixed_mode: "Mixed Mode", unknown: "Unknown"
};

export function diskTypeLabel(type: string): string {
  return LABELS[type] ?? type;
}

const RULE = "=".repeat(49);

function stamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/** Plain-text, chronological operator log. */
export function exportClassificationText(records: readonly ClassificationAuditRecord[]): string {
  const ordered = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (ordered.length === 0) return `${RULE}\nDISK PROCESSING LOG\n${RULE}\n\nNo disks have been processed.\n`;
  return ordered.map((r) => {
    const lines = [
      RULE, "DISK PROCESSING LOG", RULE, "",
      "Timestamp:", stamp(r.timestamp), "",
      "Disk:", r.diskName, "",
      "Detected Type:", diskTypeLabel(r.detectedType), "",
      "Final Type:", diskTypeLabel(r.finalType), "",
      "Confidence:", r.confidence === null ? "n/a" : r.confidence.toFixed(2), "",
      "Review Status:", r.reviewStatus, ""
    ];
    if (r.overrideReason) lines.push("Reason:", r.overrideReason, "");
    if (r.notes) lines.push("Notes:", r.notes, "");
    lines.push("Processing Result:", r.processingStatus, "", RULE, "");
    return lines.join("\n");
  }).join("\n");
}

/** Machine-readable export intended for classifier analysis (e.g. by an LLM). */
export function exportClassificationJson(records: readonly ClassificationAuditRecord[]): object {
  const ordered = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    description: "Disk classification audit records. detectedType is the classifier's original output and is never " +
      "modified; finalType is the operator-confirmed type. Records with reviewStatus manually_corrected are " +
      "classifier mistakes; analyse them to recommend detection improvements.",
    generatedAt: new Date().toISOString(),
    count: ordered.length,
    records: ordered.map((r) => ({
      timestamp: r.timestamp,
      diskName: r.diskName,
      detectedType: r.detectedType,
      finalType: r.finalType,
      confidence: r.confidence,
      reviewStatus: r.reviewStatus,
      overrideReason: r.overrideReason ?? "",
      processingStatus: r.processingStatus,
      notes: r.notes ?? ""
    }))
  };
}
