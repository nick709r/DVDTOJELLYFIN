import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "./model.js";
import { executableAvailable } from "./executable.js";
import { log } from "./logger.js";
import { runProcess } from "./process.js";

export type CapabilityStatus = "available" | "warning" | "unavailable";

export interface CapabilityCheck {
  id: "drive-detection" | "disc-reading" | "drive-ejection" | "temp-storage";
  title: string;
  ok: boolean;
  status: CapabilityStatus;
  details: string;
  remediation: readonly string[];
}

export interface CapabilityReport {
  platform: NodeJS.Platform;
  osName: string;
  checkedAt: string;
  checks: readonly CapabilityCheck[];
}

interface CapabilityServiceOptions {
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
  isExecutableAvailable?: typeof executableAvailable;
}

function osName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function driveLetter(device: string): string | null {
  return device.trim().match(/^(?:\\\\\.\\)?([a-z]):\\?$/i)?.[1]?.toUpperCase() ?? null;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function windowsHandleProbe(device: string, accessMask: string): string {
  const letter = driveLetter(device);
  if (!letter) throw new Error(`Optical drive must be a Windows drive letter such as D:, not '${device}'`);
  return encodePowerShell(`
$ErrorActionPreference = 'Stop'
try {
$code = @'
using System;
using System.Runtime.InteropServices;
public static class AutoDiscDriveProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type -TypeDefinition $code
$handle = [AutoDiscDriveProbe]::CreateFile('\\\\.\\${letter}:', ${accessMask}, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle.ToInt64() -eq -1) { throw "Cannot open optical drive; Windows error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[void][AutoDiscDriveProbe]::CloseHandle($handle)
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);
}

async function probeWritableDirectory(path: string): Promise<void> {
  const createdDirectory = await mkdir(path, { recursive: true, mode: 0o700 });
  if (createdDirectory) {
    log("info", "capabilities", "Created a missing AutoDisc temporary directory with owner-only permissions", {
      path: createdDirectory
    });
  }
  const probePath = join(path, `.autodisc-capability-${randomUUID()}`);
  const handle = await open(probePath, "wx", 0o600);
  try {
    await handle.close();
  } finally {
    await unlink(probePath);
  }
}

export class CapabilityService {
  private readonly platform: NodeJS.Platform;
  private readonly run: typeof runProcess;
  private readonly isExecutableAvailable: typeof executableAvailable;
  private readonly lastLoggedFailures = new Map<string, string>();

  constructor(
    private readonly getSettings: () => Pick<AppSettings, "opticalDevice" | "workDir">,
    options: CapabilityServiceOptions = {}
  ) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runProcess;
    this.isExecutableAvailable = options.isExecutableAvailable ?? executableAvailable;
  }

  async canDetectDrives(): Promise<boolean> {
    return (await this.checkDriveDetection()).ok;
  }

  async canReadDiscs(): Promise<boolean> {
    return (await this.checkDiscReading()).ok;
  }

  async canEjectDrives(): Promise<boolean> {
    return (await this.checkDriveEjection()).ok;
  }

  async canAccessTempDirectories(): Promise<boolean> {
    return (await this.checkTempStorage()).ok;
  }

  async getCapabilityReport(): Promise<CapabilityReport> {
    const checks = await Promise.all([
      this.checkDriveDetection(),
      this.checkDiscReading(),
      this.checkDriveEjection(),
      this.checkTempStorage()
    ]);
    for (const check of checks) {
      const failure = check.status === "available" ? null : `${check.details}; ${check.remediation.join(" ")}`;
      const previousFailure = this.lastLoggedFailures.get(check.id);
      if (failure && previousFailure !== failure) {
        log("warn", "capabilities", `${check.title} capability needs attention`, {
          capability: check.id,
          platform: this.platform,
          details: check.details,
          remediation: check.remediation
        });
        this.lastLoggedFailures.set(check.id, failure);
      } else if (!failure && previousFailure) {
        log("info", "capabilities", `${check.title} capability recovered`, {
          capability: check.id,
          platform: this.platform
        });
        this.lastLoggedFailures.delete(check.id);
      }
    }
    return {
      platform: this.platform,
      osName: osName(this.platform),
      checkedAt: new Date().toISOString(),
      checks
    };
  }

  private async checkDriveDetection(): Promise<CapabilityCheck> {
    const remediation = this.platform === "linux"
      ? [
        "Verify /sys/class/block is readable and udev is running. If using Docker, publish the device with --device=/dev/sr0:/dev/sr0.",
        "For a host service, run `sudo usermod -aG cdrom <service-user>`, add `SUBSYSTEM==\"block\", KERNEL==\"sr[0-9]*\", GROUP=\"cdrom\", MODE=\"0660\"` to `/etc/udev/rules.d/70-autodisc-optical.rules`, then run `sudo udevadm control --reload-rules` and `sudo udevadm trigger --subsystem-match=block`. Restart the service so the new group is applied."
      ]
      : this.platform === "win32"
        ? ["Ensure Windows Management Instrumentation is running and the optical drive is enabled in Device Manager."]
        : ["Run AutoDisc on Linux or Windows; optical drive discovery is not implemented for this operating system."];
    try {
      if (this.platform === "linux") {
        const entries = await readdir("/sys/class/block");
        const opticalEntries = await Promise.all(entries.map(async (entry) => {
          try {
            return (await readFile(`/sys/class/block/${entry}/device/type`, "utf8")).trim() === "5";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
              return false;
            }
            throw error;
          }
        }));
        const udevAvailable = await this.isExecutableAvailable("udevadm");
        const available = true;
        const count = opticalEntries.filter(Boolean).length;
        return {
          id: "drive-detection",
          title: "Drive Detection",
          ok: available,
          status: udevAvailable ? "available" : "warning",
          details: `Linux block-device enumeration is readable${count ? `; ${count} optical drive${count === 1 ? "" : "s"} detected` : "; no optical drive is currently detected"}.${udevAvailable ? "" : " udevadm is unavailable, so changes rely on slower polling."}`,
          remediation
        };
      }
      if (this.platform === "win32") {
        const powershell = await this.availablePowerShell();
        if (!powershell) throw new Error("PowerShell is unavailable for Windows optical drive enumeration");
        const result = await this.run(powershell, [
          "-NoProfile", "-NonInteractive", "-Command",
          "$ErrorActionPreference='Stop'; Get-CimInstance -ClassName Win32_CDROMDrive | ForEach-Object { $_.Drive }"
        ], { timeoutMs: 10_000 });
        const drives = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        return {
          id: "drive-detection",
          title: "Drive Detection",
          ok: true,
          status: "available",
          details: drives.length ? `Windows drive enumeration succeeded: ${drives.join(", ")}.` : "Windows drive enumeration succeeded; no optical drive is currently detected.",
          remediation
        };
      }
      return {
        id: "drive-detection",
        title: "Drive Detection",
        ok: false,
        status: "unavailable",
        details: `Optical drive detection is not supported on ${osName(this.platform)}.`,
        remediation
      };
    } catch (error) {
      return {
        id: "drive-detection",
        title: "Drive Detection",
        ok: false,
        status: "unavailable",
        details: error instanceof Error ? error.message : "Optical drive enumeration failed.",
        remediation
      };
    }
  }

  private async checkDiscReading(): Promise<CapabilityCheck> {
    const device = this.getSettings().opticalDevice;
    const remediation = this.platform === "linux"
      ? [
        `Grant the AutoDisc service user read access to ${device}: run \`sudo usermod -aG cdrom <service-user>\`, then restart the service or container.`,
        "If the device node is not group-readable, add `SUBSYSTEM==\"block\", KERNEL==\"sr[0-9]*\", GROUP=\"cdrom\", MODE=\"0660\"` to `/etc/udev/rules.d/70-autodisc-optical.rules`, then run `sudo udevadm control --reload-rules` and `sudo udevadm trigger --subsystem-match=block`.",
        "For Docker, add `--device=/dev/sr0:/dev/sr0` and the host device's numeric group (`stat -c '%g' /dev/sr0`) through `--group-add`. Do not chmod the device from AutoDisc."
      ]
      : this.platform === "win32"
        ? [
          "Close applications using the drive and verify it appears under Device Manager > DVD/CD-ROM drives.",
          "Check Local Group Policy at Computer Configuration > Administrative Templates > System > Removable Storage Access; ensure `CD and DVD: Deny read access` and `CD and DVD: Deny write access` are not enabled for the AutoDisc account."
        ]
        : ["Run AutoDisc on Linux or Windows; optical disc reading is not implemented for this operating system."];
    try {
      if (this.platform === "linux") {
        const handle = await open(device, constants.O_RDONLY | constants.O_NONBLOCK);
        await handle.close();
        return {
          id: "disc-reading",
          title: "Disc Reading",
          ok: true,
          status: "available",
          details: `The configured device ${device} can be opened read-only. No disc data was read.`,
          remediation
        };
      }
      if (this.platform === "win32") {
        const powershell = await this.availablePowerShell();
        if (!powershell) throw new Error("PowerShell is unavailable for the safe read-access probe");
        await this.run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsHandleProbe(device, "0x80000000")], {
          timeoutMs: 10_000
        });
        return {
          id: "disc-reading",
          title: "Disc Reading",
          ok: true,
          status: "available",
          details: `Windows granted read-only handle access to ${device}. No disc data was read.`,
          remediation
        };
      }
      throw new Error(`Optical disc reading is not supported on ${osName(this.platform)}`);
    } catch (error) {
      return {
        id: "disc-reading",
        title: "Disc Reading",
        ok: false,
        status: "unavailable",
        details: error instanceof Error ? error.message : "Optical disc read permission check failed.",
        remediation
      };
    }
  }

  private async checkDriveEjection(): Promise<CapabilityCheck> {
    const device = this.getSettings().opticalDevice;
    const remediation = this.platform === "linux"
      ? [
        `Ensure the service user has read/write access to ${device}; run \`sudo usermod -aG cdrom <service-user>\`, then restart AutoDisc.`,
        "If needed, add `SUBSYSTEM==\"block\", KERNEL==\"sr[0-9]*\", GROUP=\"cdrom\", MODE=\"0660\"` to `/etc/udev/rules.d/70-autodisc-optical.rules`, then reload rules and trigger block devices with `sudo udevadm control --reload-rules` and `sudo udevadm trigger --subsystem-match=block`.",
        "If using udisks2, authorize the service account in the applicable PolicyKit rule. On Debian/Ubuntu, install fallback tools with `sudo apt-get install eject udisks2 python3`. AutoDisc never runs as root automatically."
      ]
      : this.platform === "win32"
        ? [
          "Use a standard account with access to the optical drive and close applications holding it open.",
          "Check Local Group Policy at Computer Configuration > Administrative Templates > System > Removable Storage Access; ensure CD/DVD deny-read and deny-write policies are not enabled. AutoDisc will not request elevation automatically."
        ]
        : ["Run AutoDisc on Linux or Windows; drive ejection is not implemented for this operating system."];
    try {
      if (this.platform === "linux") {
        await access(device, constants.R_OK | constants.W_OK);
        const available = await Promise.all([
          this.isExecutableAvailable(process.env.EJECT_COMMAND ?? "eject"),
          this.isExecutableAvailable("eject"),
          this.isExecutableAvailable("python3")
        ]);
        if (!available.some(Boolean)) throw new Error("Neither an eject utility nor the Linux CD-ROM ioctl fallback (python3) is available");
        return {
          id: "drive-ejection",
          title: "Drive Ejection",
          ok: true,
          status: "available",
          details: `The configured device ${device} is readable and writable; an eject method is installed. Startup checked command availability only and did not issue an eject command.`,
          remediation
        };
      }
      if (this.platform === "win32") {
        const letter = driveLetter(device);
        if (!letter) throw new Error(`Configured Windows optical drive must be a drive letter such as D:, not '${device}'`);
        const powershell = await this.availablePowerShell();
        if (!powershell) {
          if (process.env.EJECT_COMMAND && await this.isExecutableAvailable(process.env.EJECT_COMMAND)) {
            return {
              id: "drive-ejection",
              title: "Drive Ejection",
              ok: true,
              status: "warning",
              details: "Native Windows ejection could not be preflighted; the configured eject utility is available.",
              remediation
            };
          }
          throw new Error("PowerShell is unavailable for the non-ejecting Windows drive handle probe");
        }
        try {
          await this.run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsHandleProbe(device, "0xC0000000")], {
            timeoutMs: 10_000
          });
        } catch (error) {
          return {
            id: "drive-ejection",
            title: "Drive Ejection",
            ok: true,
            status: "warning",
            details: `The native read/write handle probe failed (${error instanceof Error ? error.message : "unknown access error"}); the non-elevated PowerShell Shell fallback is available, but its permission cannot be tested without issuing an eject request.`,
            remediation
          };
        }
        return {
          id: "drive-ejection",
          title: "Drive Ejection",
          ok: true,
          status: "available",
          details: `Windows granted a read/write drive handle to ${device}. Only handle access was tested; no eject command was issued.`,
          remediation
        };
      }
      throw new Error(`Drive ejection is not supported on ${osName(this.platform)}`);
    } catch (error) {
      return {
        id: "drive-ejection",
        title: "Drive Ejection",
        ok: false,
        status: "unavailable",
        details: error instanceof Error ? error.message : "Optical drive eject permission check failed.",
        remediation
      };
    }
  }

  private async checkTempStorage(): Promise<CapabilityCheck> {
    const directories = [...new Set([this.getSettings().workDir, tmpdir()])];
    const remediation = [
      `Ensure the AutoDisc service account can create files in ${directories.join(" and ")}.`,
      "AutoDisc safely creates missing directories with owner-only permissions; it does not change permissions on existing directories."
    ];
    try {
      for (const directory of directories) await probeWritableDirectory(directory);
      return {
        id: "temp-storage",
        title: "Temp Storage",
        ok: true,
        status: "available",
        details: `Temporary files can be created and removed in ${directories.join(" and ")}.`,
        remediation
      };
    } catch (error) {
      return {
        id: "temp-storage",
        title: "Temp Storage",
        ok: false,
        status: "unavailable",
        details: error instanceof Error ? error.message : "Temporary storage access failed.",
        remediation
      };
    }
  }

  private async availablePowerShell(): Promise<string | null> {
    if (await this.isExecutableAvailable("powershell.exe")) return "powershell.exe";
    if (await this.isExecutableAvailable("pwsh.exe")) return "pwsh.exe";
    return null;
  }
}
