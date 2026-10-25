# TV job state machine

## State ownership

`JobStatus` represents the lifecycle of the disc-processing job. TV analysis and matching are recorded as job events and as a separate `TvMatchingTask` state; neither `analysis` nor `matching` is a `JobStatus`. There is no `queued` job state: jobs are created as `inspecting`.

Active job states are `inspecting`, `ripping`, `converting`, and `publishing`. Paused work is represented by `review` or `awaiting-identification`. `completed`, `failed`, `cancelled`, `ignored`, and `deleted` are terminal for normal processing. `interrupted` is recoverable.

The transition guard is `SqliteJobRepository.assertTransition`, called by `setStatus` and `finish`. Repeating the same active state is allowed for progress reporting. Startup recovery and staged-TV deletion also perform guarded database updates directly.

## Allowed transitions

```text
inspecting
  -> ripping | converting | publishing | review | awaiting-identification
  -> completed | failed | cancelled | interrupted | ignored

ripping
  -> converting | publishing | review | awaiting-identification
  -> completed | failed | cancelled | interrupted

converting
  -> publishing | review | awaiting-identification
  -> completed | failed | cancelled | interrupted

publishing
  -> review | completed | failed | cancelled | interrupted

review | awaiting-identification
  -> converting | failed | cancelled | interrupted

failed
  -> converting
interrupted
  -> converting | review | completed | failed | cancelled
```

`cancelled`, `completed`, `ignored`, and `deleted` have no processing transitions. Staged-TV deletion updates its job and task records together through the task repository; it is not a processing transition.

## TV workflows

Normal mapped TV disc:

```text
inspecting -> ripping (acquire all selected titles)
           -> converting (encode all mapped episodes)
           -> publishing (publish each episode; remain in this phase)
           -> completed
```

Unidentified or incomplete staged TV disc:

```text
inspecting -> ripping -> review / awaiting-identification
                         |
                         | manual identification and episode matching
                         v
review / awaiting-identification -> converting -> publishing -> completed
                                           |
                                           +-> review (if assignments remain incomplete)
```

Retrying a failed/interrupted staged continuation resumes at `converting` using the saved staged files. It does not reacquire or rerip the disc.

## Root cause and correction

`processMappedTvEpisodes` previously handled each title in one loop: mark the job `ripping`, acquire or load the track, then mark it `publishing` from the encoder callback. On the next track, it requested `ripping` again. The state guard correctly rejected `publishing -> ripping`; this affected multi-episode TV processing as well as the Continue action after manual matching.

The workflow now preflights all output paths, acquires any non-staged inputs as one `ripping` phase, transitions once to `converting`, and then publishes all episode outputs without moving back to an earlier phase. Staged continuation skips acquisition and starts from `converting`. The invalid `converting -> ripping` transition was removed rather than permitting another backwards edge.

Continuation logs use the `TV Match Continue` message and include the job ID, current state, requested state, and source action.

## Other state-machine audit notes

- The transition table previously allowed `cancelled -> converting`, while `JobCoordinator.resume` correctly rejected cancelled jobs. That contradictory edge has been removed.
- The `finish` repository contract previously listed `deleted`, although deletion is handled by staged-TV cleanup and the transition guard did not permit `finish(..., "deleted")`. The impossible finish status was removed from the contract.
- Music processing repeats the `ripping` status while acquiring or awaiting manual metadata, but does so before entering `converting`. Movie processing uses one acquisition followed by conversion and publication. No other backward phase transition was found in those paths.
