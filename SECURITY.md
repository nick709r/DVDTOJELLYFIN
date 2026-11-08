# Security Policy

Thank you for helping keep AutoDisc secure.

AutoDisc is designed to manage media libraries, optical drives, metadata services, and local storage. Security issues affecting confidentiality, integrity, availability, privilege escalation, authentication, file safety, data destruction, or remote code execution are taken seriously.

Please report security issues responsibly and privately.

---

# Supported Versions

The following versions currently receive security updates.

| Version | Supported |
|----------|----------|
| 2.5.x | ✅ |
| 2.0.x | ✅ |
| 1.x | ❌ |

Only the latest maintained branches receive security fixes.

Users are encouraged to upgrade to the latest release before reporting issues that may already be resolved.

---

# Reporting A Vulnerability

Please do **not** create public GitHub Issues for security vulnerabilities.

Instead, contact the maintainer privately.

When reporting a vulnerability include:

- Description of the issue
- Affected version
- Reproduction steps
- Expected behaviour
- Actual behaviour
- Screenshots or logs if applicable
- Potential impact
- Proof-of-concept code if available

The more information provided, the faster a fix can be developed.

---

# Response Process

Security reports typically follow this process:

## 1. Confirmation

The report is reviewed and reproduced.

## 2. Assessment

Impact and severity are evaluated.

Examples:

- Critical
- High
- Medium
- Low

## 3. Remediation

A security fix is developed and tested.

## 4. Release

A patched release is published.

## 5. Disclosure

After a fix becomes available, public disclosure may occur.

---

# Scope

The following categories are generally considered security vulnerabilities.

## Authentication

Examples:

- Authentication bypass
- Session hijacking
- Privilege escalation
- Password disclosure

---

## File System Access

Examples:

- Arbitrary file write
- Arbitrary file deletion
- Symlink escape
- Path traversal
- Library root bypass

---

## Media Publishing

Examples:

- Unauthorised overwrite
- Provenance corruption
- Transaction corruption
- Unsafe replacement execution

---

## Database Issues

Examples:

- SQL injection
- Privilege escalation
- Audit manipulation
- Provenance manipulation

---

## API Security

Examples:

- Authentication bypass
- Unauthorised access
- Information disclosure
- Sensitive data exposure

---

## Remote Code Execution

Examples:

- Command injection
- Process execution vulnerabilities
- Unsafe shell invocation

---

## Sensitive Information Exposure

Examples:

- API keys
- Passwords
- Session tokens
- Authentication secrets

---

# Out Of Scope

The following are generally considered out of scope.

## Third-Party Service Outages

Examples:

- TMDB downtime
- TVDB downtime
- MusicBrainz downtime

---

## Invalid Metadata

Examples:

- Incorrect movie match
- Incorrect episode ordering
- Missing metadata

These are functional issues rather than security issues.

---

## Unsupported Operating Systems

Operating systems not documented as supported may not receive security fixes.

---

## Local Administrator Actions

Actions performed intentionally by local administrators are generally not considered vulnerabilities.

Examples:

- Manual file deletion
- Manual database edits
- Intentional configuration changes

---

# Security Design Principles

AutoDisc follows several core principles.

## Never Silently Overwrite

Existing media is protected from accidental replacement.

---

## Provenance Preservation

Publishing history should remain traceable.

---

## Auditability

Administrative decisions should remain visible.

---

## Fail Closed

When safety cannot be verified, operations should stop rather than continue with uncertainty.

---

## Recovery First

Recovery paths are preferred over destructive actions whenever possible.

---

# Security Features

Current security features include:

- Password-protected administration
- Session-based authentication
- Audit history
- Provenance tracking
- Safe replacement transactions
- Quarantine-based recovery
- Startup reconciliation
- Library-boundary validation
- Symlink protection
- No-clobber publishing
- Transaction journaling

---

# Dependency Security

Dependencies are periodically reviewed and updated.

Security-sensitive updates may be released outside normal feature release schedules.

Users should keep AutoDisc updated to receive security patches.

---

# Responsible Disclosure

Please allow reasonable time for verification and remediation before publicly disclosing security vulnerabilities.

Responsible disclosure helps protect users and increases the likelihood of a successful fix.

Thank you for helping improve AutoDisc security.
