# Drive capabilities and ejection

At startup, `CapabilityService` reports drive enumeration, read-only access to the configured optical device, eject command/handle access, and writable access to both the configured work directory and the operating-system temporary directory. The read and eject checks open handles or inspect executable availability only; neither check issues an eject command or reads disc contents.

The only automatic permission repair is creating a missing AutoDisc work directory and a uniquely named, owner-only write probe that is immediately removed. AutoDisc does not change device-node permissions, modify Windows security policy, install utilities, kill processes, or elevate itself.

## Linux

- Discovery checks readable `/sys/class/block` and counts optical device types. `udevadm` provides prompt change notifications; polling remains available if it is missing.
- Reading opens the configured device read-only and non-blocking, then closes it.
- Eject preflight checks device read/write access and availability of the configured `EJECT_COMMAND` (default `eject`) or the Python CD-ROM ioctl fallback.
- Ejection tries `eject`, then a safe `udisksctl unmount` recovery followed by the CD-ROM eject ioctl through `python3`, then a direct ioctl, and finally `eject -r`.
- For permission failures, grant the service user access through the `cdrom` group and an appropriate udev rule. In containers, pass the optical device through and add its numeric group. Do not solve this with broad `chmod` permissions.

## Windows

- Discovery queries `Win32_CDROMDrive` through PowerShell/CIM; the monitor polls `MediaLoaded`.
- Read/eject preflight opens and closes a drive handle with the relevant access mask. It does not send `IOCTL_STORAGE_EJECT_MEDIA`.
- Eject tries the native `CreateFile`/`DeviceIoControl` path first (locking and dismounting before eject), then Shell/PowerShell, then a WMI `Eject` method when exposed by the provider, and finally `EJECT_COMMAND` if configured. The standard `Win32_CDROMDrive` WMI class does not define an eject method, so that fallback is provider-dependent and normally proceeds to the configured utility.
- Use a standard account with access to the drive and close applications holding it open. AutoDisc never starts itself as administrator.

Ejection waits briefly, waits for managed child processes to exit, and retries the ordered method chain up to three times. Every attempt records the drive, method, success, error, and permission state. Open handles owned by other applications cannot be closed safely by AutoDisc; a persistent busy result includes diagnostics instead of forcibly terminating those applications.

## Platform limitation

The application still has Linux-oriented storage-path and provider assumptions elsewhere in its ingestion pipeline. Windows drive enumeration, presence polling, capability checks, and ejection are implemented, but this does not constitute a complete native Windows deployment guarantee; verify work/output path configuration and media-provider compatibility before using Windows as the production host.
