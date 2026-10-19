AutoDisc Roadmap

This roadmap separates the capabilities already shipped in v1.9.1 from
remaining Version 2 development. Priorities may change based on community
feedback and validation results.

## Current status in v1.9.1

| Area | Status |
|---|---|
| Provider/workflow foundation | Implemented for the existing DVD and audio-CD sources, TMDB/MusicBrainz metadata providers, SQLite repositories, and shared job coordination. Provider-owned configuration and durable queue/event infrastructure remain future work. |
| TV analysis and matching | Implemented as explainable, confidence-scored suggestions with correction history. Built-in TV metadata providers and broad real-disc validation remain outstanding. |
| TV metadata configuration | Dashboard settings, provider credential checks, health reporting, and nullable/unavailable lookup metrics are implemented. TVDB/TMDB TV lookup and metadata caching remain disconnected from TV workflows. |
| TV workflow and review | TV plans are persisted and held for review; the dashboard exposes analysis, matching, plan approval/correction, and validation evidence. TV output execution remains disabled. |
| Universal Review Centre | Implemented for TV/CD reviews, metadata issues, processing failures, folder failures, disc-read errors, validation warnings, configuration issues, and system warnings. |
| Audio-CD publishing | Missing Music/artist directories are created; albums are atomically published under `Artist/Album`, with collision-safe naming and Review Centre recovery on destination failures. |
| Drives and platforms | One configured Linux optical drive and one active job remain supported. Multi-drive scheduling and non-Linux platforms are not implemented. |

See [V2-MIGRATION-REPORT-2026-10-19.md](./V2-MIGRATION-REPORT-2026-10-19.md)
for implementation details and acceptance blockers.

## Version 2

Version 2 focuses on transforming AutoDisc from a Jellyfin-focused ripping workflow into a more complete media archiving platform.

Architecture is a release requirement, not a later cleanup task. Version 2
must establish provider contracts, dependency-injected composition, durable
events, capability-based workflow planning, and migration gates before adding
large feature families. See [V2-ARCHITECTURE.md](./V2-ARCHITECTURE.md) for the
target boundaries, example contracts, safety model, and acceptance gates.
The v1.9.0 implementation adds a contract-tested provider API and registry.
DVD and audio-CD discovery/acquisition use open media contracts and registered
workflows. TMDB and MusicBrainz are behind metadata contracts, SQLite is split
into repository adapters, and both workflows use a shared job coordinator.
The TV analysis and episode matching engines feed a confidence-gated
DVD workflow that persists plans and holds likely TV discs for review.
Validation evidence and the universal Review Centre are exposed through the
dashboard and authenticated APIs; TV output execution remains disabled.
Provider-owned configuration, drive/platform adapters, and durable
queue/event infrastructure remain future gates. See
[V2-MIGRATION-REPORT-2026-10-19.md](./V2-MIGRATION-REPORT-2026-10-19.md) and
[TV-WORKFLOW-INTEGRATION.md](./TV-WORKFLOW-INTEGRATION.md).

AutoDisc v1.9.1 adds a separate, configuration-only TV metadata provider
catalog, provider credential checks, and read-only matching policy details.
No TV metadata search/cache implementation is connected to existing workflows.

Foundation & Core Improvements
Codebase Cleanup

    Extract domain, application, ports, adapters, and the composition root
    Add runtime-validated provider registration and API-version checks
    Remove duplicate and unused code as behavior-preserving refactors
    Establish provider contract tests and hardware-independent fakes
    Require new providers to avoid vendor-specific branches in core workflows

Extensible Platform Foundation

    Normalize media sources, manifests, artifacts, and workflow steps
    Add durable versioned events with a transactional outbox
    Keep settings and secrets namespaced and provider-owned
    Add capability declarations and a planner for compatible providers
    Version public provider contracts and document extension trust boundaries
    Keep built-in providers as the initial supported extension mechanism

Reliability & Diagnostics

    Improved error handling
    Better logging and troubleshooting tools
    Dependency validation and health checks
    Storage and permission verification

User Interface

    [Implemented] Light/dark theme and TV/review dashboard views
    [Remaining] Further mobile usability and interface polish

Advanced TV Series Support

Smart Episode Detection

    [Implemented] Explainable analysis and episode-match suggestions
    [Implemented] Confidence, alternatives, duplicate/alternate and bonus analysis
    [Remaining] Real-disc validation and built-in TV metadata providers

TV Library Organization

    [Remaining] TV episode acquisition, naming, folders, and publication
    [Remaining] Safe cleanup/recovery and media-library output policies

Metadata Improvements

    [Implemented] TV workflow plan, correction history, and validation evidence
    [Remaining] TV-specific provider integration and real-world calibration

Media Library Support
Library Profiles

    Generic Media Library
    Jellyfin
    Plex
    Emby
    Custom Folder Templates

Collection Management

    Consistent naming standards
    Metadata-based organization
    Improved archival workflows

Multi-Drive Support
Drive Management

    Support for multiple optical drives
    Individual drive monitoring
    Real-time drive status reporting
    Automatic drive assignment

Queue Management

    Centralized processing queue
    Automatic job scheduling
    Queue prioritization
    Large collection workflows

Statistics & Monitoring

Processing Statistics

    [Implemented] Disc/job history and movie/CD processing statistics
    [Implemented] TV analysis, confidence, review, correction, and validation summaries
    [Remaining] TV episodes archived (TV output execution is not implemented)

Storage Analytics

    Storage usage tracking
    Historical growth metrics
    Estimated archive size information

Drive Health

    Per-drive statistics
    Read failure tracking
    Lifetime drive usage information

Quality of Life Improvements
Setup Wizard

    First-run setup wizard
    Automatic drive detection
    Library path validation
    Dependency verification

Notifications

    Discord notifications
    Email notifications
    Home Assistant integration
    Job completion alerts
    Failure notifications

Cross-platform exploration (later Version 2 work; not started)

Cross-platform support is not part of the v1.9.0 release or current Linux
workflow gates; keep it on the Version 2 roadmap until the Linux workflow
acceptance criteria are met.
Windows Support
Native Installer

    Windows installation package
    Automatic dependency detection
    Simplified setup process

Windows Integration

    Optical drive discovery
    Improved permissions handling
    Platform-specific diagnostics

macOS Support
Native Compatibility

    Intel Mac support
    Apple Silicon support
    External optical drive support

macOS Integration

    Automatic device detection
    Streamlined setup workflow
    Platform-specific troubleshooting tools

Desktop Application
Cross-Platform Application

    Dedicated desktop application
    Native installers
    Integrated update system
    Consistent user experience across all supported platforms

Hardware Compatibility

    Improved USB optical drive support
    Platform-specific hardware detection
    Enhanced diagnostics
