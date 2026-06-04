# vTrack — Windows Build Instructions

## Step 1 — Install Node.js (skip if already installed)
Download and install from: https://nodejs.org (choose the LTS version)
After installing, restart your terminal/PowerShell.

## Step 2 — Open this folder in terminal
Right-click inside the `vtrack-source` folder → "Open in Terminal" (or PowerShell)
Or navigate manually:
```
cd C:\path\to\vtrack-source
```

## Step 3 — Install dependencies
```
npm install
```
This downloads all required packages (~500MB, takes a few minutes, needs internet).
On Windows this also compiles the native modules (uiohook-napi, get-windows), so you
need the build tools listed under Troubleshooting if `npm install` complains.

## Step 4 — Build the app
```
npm run build
```
This compiles the React UI. Should finish in under 30 seconds.

---

## Step 5 — (ONE TIME) Create your code-signing certificate
Do this **once ever**, in PowerShell **as Administrator**. It produces a free
self-signed certificate that labels the installer as "Vyral Digital" instead of
"Unknown Publisher".

```
powershell -ExecutionPolicy Bypass -File scripts\make-selfsigned-cert.ps1
```

It will ask you for a password to protect the private key — remember it, you need it
in Step 6. It creates two files in the `certs\` folder:
- `vtrack-codesign.pfx`  → PRIVATE key. **KEEP SECRET. Never share. Never commit.**
- `vtrack-codesign.cer`  → PUBLIC cert. Safe to copy to editor machines (Step 8).

> You can reuse the same `.pfx` for every future build until it expires (5 years).
> Skip Steps 5–6 entirely if you just want an unsigned build (it still works, it just
> shows "Unknown Publisher" on the install prompt).

## Step 6 — Package the SIGNED Windows installer
In the **same PowerShell window**, point the build at your cert, then package:

```
$env:WIN_CSC_LINK = "$PWD\certs\vtrack-codesign.pfx"
$env:WIN_CSC_KEY_PASSWORD = "<the password you set in Step 5>"
npm run package
```

This creates the signed `.exe` installer. Takes 2–5 minutes.

> For an **unsigned** build instead, just run `npm run package` without setting those
> two env vars.

## Step 7 — Find your installer
Look in the `dist-packaged` folder:
```
dist-packaged\vTrack-Setup-0.5.0-A.exe
```
That's your installer.

## Step 8 — (ONE TIME per editor machine) Trust the certificate
So the editor's Windows shows "Vyral Digital" instead of "Unknown Publisher", copy
`certs\vtrack-codesign.cer` to that machine and run, in PowerShell **as Administrator**:

```
powershell -ExecutionPolicy Bypass -File trust-cert.ps1 -CerPath C:\path\to\vtrack-codesign.cer
```

Distribute ONLY the `.cer` to editor machines — **never the `.pfx`**.

---

## What changed in this build (security)
- **Runs as the normal user (`asInvoker`), not administrator** — least-privilege, so the
  app can't be used as an admin foothold. No UAC prompt on every launch.
- **Installs to Program Files (`perMachine`)** — a one-time UAC prompt appears during
  *install only*. This locks the binary in a folder normal users can't overwrite, which
  is what actually protects against EXE/DLL hijacking.
- **Renderer hardened** — sandbox enabled, navigation/window-open/webview guards added.
- **Optional self-signed signing** (Steps 5–8) removes the "Unknown Publisher" warning
  on machines where the `.cer` is trusted.

> Note: a self-signed cert does **not** remove the SmartScreen "Windows protected your
> PC" blue screen for installers *downloaded from a browser*. To avoid that, copy the
> installer to editor machines via USB / network share instead of a web download. Only a
> paid CA certificate removes SmartScreen for web downloads.

## Troubleshooting
- If `npm install` fails: make sure you have internet connection and Node.js is installed
- If `npm run package` fails with a permissions error: run the terminal as Administrator
- If you get a "Python not found" error: install Python from https://python.org (needed for native modules)
- If you get a "Visual Studio Build Tools" error: install from https://aka.ms/vs/17/release/vs_BuildTools.exe (select "Desktop development with C++")
- If signing fails with "cannot find certificate": double-check the `WIN_CSC_LINK` path points to your real `.pfx` and `WIN_CSC_KEY_PASSWORD` matches the password from Step 5
