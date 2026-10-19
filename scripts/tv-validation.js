import { readFile, writeFile } from "node:fs/promises";
import { repositories } from "../dist/db.js";
import { TvValidationService } from "../dist/application/tv-validation-service.js";

const validation = new TvValidationService(
  repositories.tvValidationEvidence,
  repositories.tvEpisodeFeedback,
  repositories.tvProcessingPlans
);

function usage() {
  throw new Error([
    "Usage:",
    "  node scripts/tv-validation.js list",
    "  node scripts/tv-validation.js summary",
    "  node scripts/tv-validation.js export <file.json> [offset] [limit]",
    "  node scripts/tv-validation.js import <file.json>",
    "  node scripts/tv-validation.js report <case-id>"
  ].join("\n"));
}

async function main() {
  const [command, argument, offsetArgument, limitArgument] = process.argv.slice(2);
  if (command === "list" && argument === undefined) {
    const cases = validation.list().map((entry) => ({
      id: entry.id,
      capturedAt: entry.capturedAt,
      origin: entry.origin,
      fingerprint: entry.source.fingerprint,
      label: entry.source.label,
      decision: entry.plan.state,
      unresolvedTracks: entry.matches.items.filter((item) =>
        item.decision === "unknown" || item.manualReviewRequired
      ).length
    }));
    process.stdout.write(`${JSON.stringify({ cases }, null, 2)}\n`);
    return;
  }
  if (command === "summary" && argument === undefined) {
    process.stdout.write(`${JSON.stringify(validation.summary(), null, 2)}\n`);
    return;
  }
  if (command === "export" && argument) {
    const offset = offsetArgument === undefined ? 0 : Number(offsetArgument);
    const limit = limitArgument === undefined ? 1000 : Number(limitArgument);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) usage();
    const dataset = validation.exportDataset(offset, limit);
    await writeFile(argument, `${JSON.stringify(dataset, null, 2)}\n`);
    process.stdout.write(`Exported ${dataset.cases.length} validation case(s) to ${argument}\n`);
    return;
  }
  if (command === "import" && argument) {
    const serialized = await readFile(argument, "utf8");
    const result = validation.importDataset(serialized);
    process.stdout.write(`Imported ${result.imported} validation case(s)\n`);
    return;
  }
  if (command === "report" && argument) {
    process.stdout.write(validation.report(argument));
    return;
  }
  usage();
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => repositories.close());
