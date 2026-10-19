# AutoDisc v2 TV Validation and Evidence

## Purpose and safety

TV workflow runs that pass the DVD workflow's TV prefilter now automatically
capture a validation case. Capturing evidence does not rip, convert, rename,
move, or publish TV media. The feature collects observations so the analysis,
episode matcher, confidence thresholds, and human corrections can be tested
against real collections before any automation is considered.

Captured cases include:

- The DVD source provider, media kind, disc label, local disc fingerprint, and
  complete provider manifest (title IDs, titles, runtimes, and manifest
  attributes).
- Raw metadata-provider candidates and normalized series, season, and episode
  candidates. Provider failures are identified by provider ID; error messages
  are intentionally excluded from the evidence payload.
- The TV analysis and episode match reports, with confidence components,
  candidate rankings, evidence strings, and recommendations.
- The optional `AUTODISC_BUILD_ID` environment value (or `unknown`) plus a
  snapshot of the prefilter and confidence/matching thresholds.
- The confidence-gated processing plan and its review history.
- Accepted, rejected, and manual episode corrections for the disc fingerprint.

Evidence is stored in SQLite by migration 8 in `tv_validation_evidence`.
Existing databases are upgraded in place. Imported cases use a separate
`origin` marker and are not fed into the matching engine as corrections.

## Local tools

Run these from the AutoDisc repository root. The commands use the configured
`DATABASE_PATH` or the application default `./data/autodisc.sqlite`.

```sh
npm run tv-validation -- list
npm run tv-validation -- summary
npm run tv-validation -- report <case-id>
npm run tv-validation -- export ./tv-validation-dataset.json
npm run tv-validation -- export ./tv-validation-next.json 1000 1000
npm run tv-validation -- import ./tv-validation-dataset.json
```

`list` shows captured/imported cases. `summary` aggregates case counts,
unresolved tracks, plan confidence, review states, match decisions, and
correction outcomes. It also compares the original prediction with later
accepted/manual corrections as held-out evidence: exact matches, incorrect
suggestions, abstentions, and rejected candidates selected/avoided. This
comparison is only as trustworthy as the human correction and is not a
calibrated accuracy estimate.
`report` prints a per-case Markdown explanation. `export` writes a complete
versioned JSON dataset; `import` validates and transactionally adds its cases.
Exports default to the first 1,000 cases; optional offset and limit arguments
allow large corpora to be exchanged in chunks. Both import and export enforce
a 50 MiB file limit.
Duplicate case IDs reject the import instead of overwriting evidence.

Dataset envelope:

```json
{
  "format": "autodisc-tv-validation",
  "schemaVersion": 1,
  "exportedAt": "ISO-8601 timestamp",
  "cases": ["complete immutable evidence records"]
}
```

Imports are limited to 50 MiB and 10,000 cases per dataset. The import path
validates required structures and keeps writes atomic. The JSON dataset is
intended for building reviewed test corpora; importing it does not run analysis
or modify correction history used by production matching.

## Reports and decision explanations

Reports show series, season, and disc-position confidence; each track's
runtime, decision, confidence, review requirement, proposed episodes, ranked
alternatives, score components, and evidence; plus unresolved tracks,
recommendations, correction records, and reviewer decisions. Rules are named
where the report can identify a specific gate, including minimum confidence,
minimum candidate margin, cross-track conflict, user correction, and
classification of duplicate/alternate/commentary/bonus/special-feature items.
Provider-declared multipart groups and runtime comparison are also described.
Reports include the weights used for series (`0.60` metadata, `0.30`
historical, `0.10` title similarity), season (`0.55`, `0.30`, `0.15` metadata,
history, disc structure), disc position (`0.60` structure, `0.40` history),
and episode (`0.50` metadata, `0.20` runtime, `0.10` title, `0.20` history)
ranking. Scores are normalized over available components. Multipart ranking
uses `0.70` metadata and `0.30` combined-runtime similarity when both exist.
The policy snapshot records these weights and operative thresholds for each
case.

Confidence is an evidence ranking, not a calibrated probability. Reports
explicitly call out the current 0.72 episode threshold, 0.12 ambiguity margin,
and the plan's minimum-evidence aggregation. Corrections recorded after a
case was first captured are marked as later human evidence; they are not
misrepresented as inputs to that original match result.

## Known assumptions to validate on discs

1. **The TV prefilter is heuristic.** It accepts a label containing
   `season`/`series`/`episode` or an `S1D1`-style token, or at least three
   10–100 minute titles with similar runtimes and no title longer than 100
   minutes. A movie titled "Season of..." can be a false positive. A two-title
   double feature, atypical runtime, incomplete manifest, or unlabeled TV disc
   can be a false negative and will not yet be captured.
2. **The fingerprint is not a physical disc identity.** It hashes a normalized
   label and title IDs, durations, and names. Repressings with matching
   metadata can collide; the same disc with different labels or provider
   manifests can differ. It does not hash sectors, volume IDs, or video
   content. The exact fingerprint algorithm is recorded with each case.
3. **Metadata confidence is trusted, not calibrated.** There are currently no
   built-in TV metadata providers. Provider scores, episode numbering,
   season-zero conventions, release-specific ordering, and runtimes may be
   absent or wrong.
4. **Runtime is a weak signal.** Manifest duration can include studio logos,
   credits, playlists, padding, or split/combined episodes. The matcher applies
   a simple runtime comparison and does not inspect chapter boundaries or
   content.
5. **Track classification is heuristic.** Duplicate/alternate detection,
   commentary, bonus, special, and episode candidates need validation on
   anime, sitcoms, dramas, recap discs, commentary-heavy releases, and
   multi-disc seasons.
6. **Confidence values are not probabilities.** Candidate confidence,
   threshold/margin decisions, and the plan's minimum-evidence score have not
   been empirically calibrated. Human-accepted and manually assigned results
   currently receive confidence 1.0 to distinguish explicit correction from
   a machine suggestion; do not interpret that as statistical certainty.
7. **Correction identity can be imperfect.** Feedback is attached to the
   current label/manifest fingerprint and item signature. It does not yet
   include a sector-derived identity or a cross-release correction scope.
8. **Evidence only captures detected TV candidates.** It cannot currently
   measure false negatives in the prefilter automatically. Include known
   missed discs as reviewed/imported cases when assembling a corpus.

Before relying on the summary for a quality claim, label cases with trusted
series, season, and per-track episode outcomes. Only corrections recorded
after a case's initial analysis are used for held-out comparisons; corrections
already consumed as matcher inputs are excluded to avoid measuring a result
against its own training signal. A reviewer should independently verify
corrections before treating the comparison as a ground-truth metric.

## Sharing datasets

An export can include disc labels, title names, metadata-provider payloads,
reviewer names, correction reasons, and track-level structure. Inspect and
redact sensitive or identifying material before submitting a dataset to
another person or project. No dataset is uploaded automatically. Imported
records are data only and never execute media operations.

## Remaining validation work

- Collect diverse, manually reviewed TV DVD cases, including known TV
  prefilter misses and false positives.
- Define a trusted ground-truth format and report calibrated precision,
  recall, unknown/abstention rate, and confidence calibration by disc type.
- Add corpus deduplication across equivalent manifests and versioned engine
  provenance so results can be compared between algorithm revisions. Set
  `AUTODISC_BUILD_ID` in the deployment when a reproducible build/commit
  identifier is available; the default `unknown` is not sufficient to
  attribute historical results to an exact code revision.
- Validate label/runtime/playlist/track heuristics before allowing any future
  unattended episode mapping. TV output execution stays disabled.
