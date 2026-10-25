# Release-readiness audit

## Scope

This audit focused on workflow robustness in the Dashboard, unified Review Queue, TV review lists, and diagnostics selection. It did not introduce product features or change identification decisions.

## Findings and fixes

| Area | Finding | Change |
| --- | --- | --- |
| Review Queue refresh | The Refresh control reloaded general review items and extracted-media jobs, but omitted TV plans and staged TV matching tasks on the same page. | Refresh now reloads both the general review centre and TV review sections. Forget Disc and review actions use the same combined refresh. |
| Stale responses | Rapid filter changes or repeated requests could allow an older response to overwrite a newer TV filter, review filter, diagnostics selection, Dashboard summary, or chart range. | Added per-view request generations. Results only render when they belong to the latest request; diagnostics child loads use the same generation guard. |
| Dashboard freshness | Review mutations did not consistently emit the status event used to refresh other open clients. Dashboard attention counts could therefore remain stale after review resolution, dismissal, approval, retry, or TV plan review. | Those mutations now emit a status event. The Dashboard debounces attention refreshes while visible, while job completion continues to trigger the full Dashboard refresh. |
| Review-job count | The Dashboard counted every preserved-media review job, including completed and dismissed records, as waiting for review. It could also count a pending review job or TV plan already represented by a review item. | Waiting counts and the Continue Processing action now include pending review jobs only. When the review-item list is complete, shared job IDs and disc fingerprints are used to avoid counting the same queue item twice. |

## Remaining risks

- Dashboard attention data comes from separate endpoints and is not a transactional snapshot. A change during the requests can briefly produce counts from adjacent states; the status-event refresh corrects this when the page is open.
- Cross-source deduplication is possible only when shared job IDs or fingerprints are available and all active/retrying review items fit within the two 250-item API pages. Above those limits, the Dashboard favors avoiding undercounts and may temporarily overcount related queue entries.
- The Review Queue’s general review list is limited to 250 records and the TV plans/tasks are limited by their respective API limits. Larger installations may need server-side pagination and aggregate counts.
- Runtime/build tests could not be run because Node.js and npm are unavailable in the environment. Static checks are recorded with the task results.

## Release assessment

The identified refresh and stale-response defects have low-risk client/server fixes. No release blocker was found in the reviewed paths after those changes, but the non-atomic and potentially overlapping Dashboard count sources should be clarified before using the count as a unique-disc KPI.
