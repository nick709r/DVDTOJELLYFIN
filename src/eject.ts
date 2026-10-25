import { setTimeout as delay } from "node:timers/promises";
import { log } from "./logger.js";
import { executableAvailable } from "./executable.js";
import { runProcess, waitForManagedProcesses } from "./process.js";

interface EjectMethod {
  name: string;
  command: string;
  args: (device: string) => string[];
}

interface EjectServiceOptions {
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
  isExecutableAvailable?: typeof executableAvailable;
  waitForProcesses?: typeof waitForManagedProcesses;
  pause?: (milliseconds: number) => Promise<void>;
}

function driveLetter(device: string): string | null {
  const match = device.trim().match(/^(?:\\\\\.\\)?([a-z]):\\?$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const nativeEjectScript = (letter: string): string => encodedPowerShell(`
$ErrorActionPreference = 'Stop'
try {
$native = @'
using System;
using System.Runtime.InteropServices;
public static class AutoDiscNativeEject {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  public static int Eject(string name) {
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint SHARE_READ = 1;
    const uint SHARE_WRITE = 2;
    const uint OPEN_EXISTING = 3;
    const uint LOCK_VOLUME = 0x00090018;
    const uint DISMOUNT_VOLUME = 0x00090020;
    const uint EJECT_MEDIA = 0x002D4808;
    const uint UNLOCK_VOLUME = 0x0009001C;
    IntPtr handle = CreateFile(name, GENERIC_READ | GENERIC_WRITE, SHARE_READ | SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    uint returned;
    bool locked = false;
    try {
      if (!DeviceIoControl(handle, LOCK_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        return Marshal.GetLastWin32Error();
      locked = true;
      if (!DeviceIoControl(handle, DISMOUNT_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        return Marshal.GetLastWin32Error();
      if (!DeviceIoControl(handle, EJECT_MEDIA, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        return Marshal.GetLastWin32Error();
      return 0;
    } finally {
      if (locked) DeviceIoControl(handle, UNLOCK_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero);
      CloseHandle(handle);
    }
  }
}
'@
Add-Type -TypeDefinition $native
$code = [AutoDiscNativeEject]::Eject('\\\\.\\${letter}:')
if ($code -ne 0) { throw "Native eject failed with Windows error $code" }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);

const shellEjectScript = (letter: string): string => encodedPowerShell(`
$ErrorActionPreference = 'Stop'
try {
$shell = New-Object -ComObject Shell.Application
$drive = $shell.NameSpace('${letter}:\\')
if (-not $drive -or -not $drive.Self) { throw 'The configured optical drive was not found by Windows Shell.' }
$drive.Self.InvokeVerb('Eject')
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);

const wmiEjectScript = (letter: string): string => encodedPowerShell(`
$ErrorActionPreference = 'Stop'
try {
$drive = Get-CimInstance -ClassName Win32_CDROMDrive | Where-Object { $_.Drive -eq '${letter}:' }
if (-not $drive) { throw 'The configured optical drive was not found by WMI.' }
$result = Invoke-CimMethod -InputObject $drive -MethodName Eject -ErrorAction Stop
if ($result.ReturnValue -ne 0) { throw "WMI eject failed with code $($result.ReturnValue)" }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);

function linuxEjectMethods(): EjectMethod[] {
  const ejectCommand = process.env.EJECT_COMMAND ?? "eject";
  return [
    { name: process.env.EJECT_COMMAND ? "configured-fallback" : "eject", command: ejectCommand, args: (device) => [device] },
    {
      name: "udisksctl-unmount-and-eject",
      command: "udisksctl",
      args: (device) => ["unmount", "--block-device", device]
    },
    {
      name: "linux-cdrom-ioctl",
      command: "python3",
      args: (device) => ["-c", "import fcntl, os, sys; fd=os.open(sys.argv[1], os.O_RDONLY | os.O_NONBLOCK); fcntl.ioctl(fd, 0x5309, 0); os.close(fd)", device]
    },
    { name: "eject-force-fallback", command: "eject", args: (device) => ["-r", device] }
  ];
}

function windowsEjectMethods(letter: string, powershell: string): EjectMethod[] {
  return [
    { name: "windows-native-deviceiocontrol", command: powershell, args: () => ["-NoProfile", "-NonInteractive", "-EncodedCommand", nativeEjectScript(letter)] },
    { name: "powershell-shell-eject", command: powershell, args: () => ["-NoProfile", "-NonInteractive", "-EncodedCommand", shellEjectScript(letter)] },
    { name: "wmi-cdrom-eject", command: powershell, args: () => ["-NoProfile", "-NonInteractive", "-EncodedCommand", wmiEjectScript(letter)] },
  ];
}

function permissionState(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /access is denied|permission|operation not permitted|(?:windows|win32) error 5\b|\b(?:eacces|eperm)\b/i.test(message)
    ? "denied"
    : "not-confirmed";
}

export class EjectService {
  private readonly platform: NodeJS.Platform;
  private readonly run: typeof runProcess;
  private readonly isExecutableAvailable: typeof executableAvailable;
  private readonly waitForProcesses: typeof waitForManagedProcesses;
  private readonly pause: (milliseconds: number) => Promise<void>;

  constructor(options: EjectServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runProcess;
    this.isExecutableAvailable = options.isExecutableAvailable ?? executableAvailable;
    this.waitForProcesses = options.waitForProcesses ?? waitForManagedProcesses;
    this.pause = options.pause ?? ((milliseconds) => delay(milliseconds));
  }

  private rejectRequest(device: string, letter: string | null, error: string): never {
    log("error", "eject", "Optical drive eject request could not be started", {
      driveId: device,
      driveLetter: letter,
      requestedAction: "eject",
      ejectMethod: null,
      success: false,
      error,
      permissionsState: "not-confirmed"
    });
    throw new Error(error);
  }

  async eject(device: string): Promise<void> {
    const letter = this.platform === "win32" ? driveLetter(device) : null;
    const powershell = this.platform === "win32"
      ? (await this.isExecutableAvailable("powershell.exe") ? "powershell.exe" :
        await this.isExecutableAvailable("pwsh.exe") ? "pwsh.exe" : null)
      : null;
    const methods = this.platform === "win32"
      ? [
        ...(letter && powershell ? windowsEjectMethods(letter, powershell) : []),
        ...(process.env.EJECT_COMMAND
          ? [{ name: "configured-fallback", command: process.env.EJECT_COMMAND, args: (device: string) => [device] }]
          : [])
      ]
      : this.platform === "linux" ? linuxEjectMethods() : [];
    const failures: string[] = [];

    if (this.platform === "win32" && !letter) {
      return this.rejectRequest(device, letter, `Invalid Windows optical drive '${device}'; use a drive letter such as D:.`);
    }
    if (this.platform === "win32" && !powershell && !process.env.EJECT_COMMAND) {
      return this.rejectRequest(device, letter, "No PowerShell executable is available for Windows drive ejection.");
    }
    if (!methods.length) {
      return this.rejectRequest(device, letter, `Drive ejection is not supported on operating system '${this.platform}'.`);
    }

    await this.pause(500);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const processesExited = await this.waitForProcesses(10_000);
      if (!processesExited) {
        const error = "Managed child processes are still running; drive access was not released";
        failures.push(`attempt ${attempt}: ${error}`);
        log("warn", "eject", "Optical drive eject attempt deferred while child processes remain active", {
          driveId: device,
          driveLetter: letter,
          requestedAction: "eject",
          ejectMethod: null,
          success: false,
          error,
          permissionsState: "not-confirmed",
          attempt
        });
      } else {
        for (const method of methods) {
          if (!await this.isExecutableAvailable(method.command)) {
            const error = `Required utility '${method.command}' is unavailable`;
            failures.push(`attempt ${attempt}, ${method.name}: ${error}`);
            log("warn", "eject", "Eject method is unavailable", {
              driveId: device,
              driveLetter: letter,
              requestedAction: "eject",
              ejectMethod: method.name,
              success: false,
              error,
              permissionsState: "unavailable",
              attempt
            });
            continue;
          }
          try {
            if (method.name === "udisksctl-unmount-and-eject") {
              try {
                await this.run(method.command, method.args(device), { timeoutMs: 15_000 });
              } catch (error) {
                log("warn", "eject", "udisksctl could not unmount the optical device before fallback eject", {
                  driveId: device,
                  driveLetter: letter,
                  requestedAction: "eject",
                  ejectMethod: method.name,
                  success: false,
                  error: error instanceof Error ? error.message : "unknown unmount failure",
                  permissionsState: permissionState(error),
                  attempt
                });
              }
              const ioctl = methods.find((candidate) => candidate.name === "linux-cdrom-ioctl");
              if (ioctl && await this.isExecutableAvailable(ioctl.command)) {
                await this.run(ioctl.command, ioctl.args(device), { timeoutMs: 15_000 });
              } else {
                throw new Error("Linux CD-ROM ioctl fallback requires python3, which is unavailable");
              }
            } else {
              await this.run(method.command, method.args(device), { timeoutMs: 15_000 });
            }
            log("info", "eject", "Optical drive ejected successfully", {
              driveId: device,
              driveLetter: letter,
              requestedAction: "eject",
              ejectMethod: method.name,
              success: true,
              error: null,
              permissionsState: "granted",
              attempt
            });
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : "unknown eject failure";
            failures.push(`attempt ${attempt}, ${method.name}: ${message}`);
            log("warn", "eject", "Optical drive eject method failed", {
              driveId: device,
              driveLetter: letter,
              requestedAction: "eject",
              ejectMethod: method.name,
              success: false,
              error: message,
              permissionsState: permissionState(error),
              attempt
            });
            await this.waitForProcesses(1000);
          }
        }
      }
      if (attempt < 3) await this.pause(attempt * 500);
    }

    const message = `Could not eject optical drive ${device} after 3 attempts: ${failures.join(" | ")}`;
    log("error", "eject", "All optical drive eject methods failed", {
      driveId: device,
      driveLetter: letter,
      requestedAction: "eject",
      ejectMethod: null,
      success: false,
      error: message,
      permissionsState: failures.some((failure) =>
        /permission|access is denied|(?:windows|win32) error 5\b|\b(?:eacces|eperm)\b/i.test(failure))
        ? "denied" : "not-confirmed"
    });
    throw new Error(message);
  }
}

const ejectService = new EjectService();

export async function ejectDisc(device: string): Promise<void> {
  await ejectService.eject(device);
}
