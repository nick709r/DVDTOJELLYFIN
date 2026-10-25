# AutoDisc Post-Refactor Audit

Date: 2026-10-24

## Summary

Audited the active SPA routes, navigation, named renderer/loader functions, state properties, dialog entry points, settings inputs, and TV recovery workflows after the navigation refactor.

Only provably unused code was removed:

- `state.metrics` and its write in `renderMetrics`; the snapshot is consumed directly and the cached property was never read.
- `state.tvMetadataProviders` and its write in `renderTvMetadataProviders`; the provider data is rendered and used to populate controls without later reading state.
- The unused `id` attributes `stage-row`, `classification-review`, and `tv-review-queue`. Their styling and behavior use classes, child controls, or other selectors; no application code or stylesheet referenced these IDs.

No active page, review workflow, dialog, or TV recovery component was removed.

## Dead routes and unused pages

The authenticated SPA contains seven active pages:

| Page | Navigation reachability |
|---|---|
| Dashboard | Direct primary entry |
| History | Library → Media History |
| Diagnostics | Storage → Paths & Diagnostics |
| TV Analysis / Episode Matching | Identification → TV Matching & Analysis |
| Review Centre | Tasks → Review Queue |
| TV Validation / Statistics | Tasks → Activity & Insights |
| Settings | Storage and Settings subnavigation anchors |

All seven routes have current navigation entries; direct Dashboard and review actions also route to valid pages. No orphaned `page-*` section or stale TV Disc Review, Episode Matching, or Statistics route remains.

`/setup` is intentionally separate from the authenticated SPA. It is a first-run, two-step administrator setup wizard and is not an abandoned application page.

## Unused functions, components, and state

- No named function declarations were found with declaration-only usage in the static occurrence scan.
- The two write-only state properties and three unreferenced HTML IDs listed above were removed.
- IDs such as `page-dashboard`, `page-tv-analysis`, and review filter IDs are used through computed route selectors, attribute delegation, or a selector loop; they are not dead merely because they lack a literal `$("#id")` read.
- No currently reachable renderer, route loader, review action, or output-preview helper was identified as unused.

## Duplicate controls and dialogs

No duplicate dialog IDs exist. The current dialogs have different purposes and safeguards:

- Login and password-change dialogs handle distinct authentication states.
- Directory picker and music metadata dialogs serve separate settings/job workflows.
- TV identification and staged-track preview are different review actions.
- Forget Disc removes historical records; Remove disc from review removes staged TV work; Delete unmatched tracks removes only unmatched staged tracks. Their confirmation dialogs must remain separate because their scopes differ.

Controls that look similar are contextual, not duplicates: dashboard shortcuts lead into the queue, while per-item controls act on a particular disc or track. TV validation filtering and general review filtering operate on separate datasets.

### Follow-up issue: queue refresh coverage

The Review Queue page has a single Refresh button, but its current handler refreshes general review records and preserved-media jobs; TV plans and staged TV tasks are refreshed through their separate loader/filter path. The control is reachable, not dead code, so it was not removed or behaviorally changed in this dead-code cleanup. A follow-up should make Refresh reload all queue sections together and report failures without leaving stale sections presented as current.

## Settings models

- `outputDestinations` is the editable profile-based routing model.
- `legacyOutputPaths` is still read as a fallback when rendering Jellyfin output previews with no explicit root or category override. It is populated from legacy settings on load/save, so it is reachable and was retained.
- Repeated `name="notes"` and `name="password"` values occur in separate forms or dialogs (classification/recovery, login/password change, and first-run setup). They are not duplicate fields within the settings form.
- TV processing and TV metadata settings both display matching-policy information. Both are reachable; collapsing the static and dynamic policy displays should be done only after confirming which source is authoritative and preserving the user-facing explanation.

## Legacy TV workflow code

No TV workflow was deleted during this audit. These components are still reachable:

- Diagnostics media recovery and classification forms support correcting stored disc identity and classification.
- TV plan recovery supports track-to-provider-episode mapping and notes.
- The unified review queue renders staged-disc matching tasks and TV processing plans.
- Provider/sequential/runtime/manual assignment provenance is displayed on current review cards.

The old standalone TV Disc Review route is absent; the staged-disc functionality is rendered through the Unified Review Queue.

## Cleanup plan

1. **Completed — remove write-only state and unreferenced IDs.** No runtime behavior depended on these properties or IDs.
2. **Unify queue refresh.** Load review records, preserved-media jobs, TV plans, and staged TV tasks under one refresh operation; surface partial failures and avoid success-shaped stale content.
3. **Consolidate matching-policy presentation.** Identify the authoritative policy source, then remove or transform the duplicate display while retaining explanatory confidence guidance.
4. **Assess legacy output-path compatibility.** Trace migration and API consumers before removing `legacyOutputPaths`; remove only when old settings can no longer be returned or required for profile previews.
5. **Reassess contextual identification entry points with usage data.** Keep the global plan-identification action and per-disc series correction until evidence shows one is redundant.
6. **Keep destructive confirmations scoped.** Do not merge deletion dialogs unless the confirmation text and target semantics remain unambiguous.

No further reachable code was removed because the remaining overlap either represents distinct behavior or depends on settings/API compatibility that has not been proven obsolete.
