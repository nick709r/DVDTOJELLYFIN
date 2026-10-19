AutoDisc Roadmap

This roadmap outlines planned features and improvements for upcoming releases. Priorities may change based on community feedback and development progress.
Version 2

Version 2 focuses on transforming AutoDisc from a Jellyfin-focused ripping workflow into a more complete media archiving platform.

Architecture is a release requirement, not a later cleanup task. Version 2
must establish provider contracts, dependency-injected composition, durable
events, capability-based workflow planning, and migration gates before adding
large feature families. See [V2-ARCHITECTURE.md](./V2-ARCHITECTURE.md) for the
target boundaries, example contracts, safety model, and acceptance gates.
The first implementation increment adds a contract-tested provider API and
registry. DVD and audio-CD discovery/acquisition are now wired through source
providers; migrating downstream metadata, transform, publication, persistence,
and platform behavior remains part of Gate A.

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

    Light theme support
    Theme selector
    Mobile usability improvements
    General UI polish and consistency updates

Advanced TV Series Support
Smart Episode Detection

    Automatic identification of episode-length titles
    Improved handling of multi-episode discs
    Better filtering of duplicates and alternate tracks
    Bonus feature detection

TV Library Organization

    Automatic season folder creation
    Episode organization workflows
    Reduced manual file renaming
    Structured output for media servers

Metadata Improvements

    Series recognition
    Episode matching assistance
    Improved naming accuracy
    Better handling of specials and bonus content

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

    Total discs processed
    Movies archived
    TV episodes archived
    Success and failure tracking
    Processing time metrics

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

Version 2.5

Version 2.5 focuses on expanding AutoDisc beyond Linux.
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
