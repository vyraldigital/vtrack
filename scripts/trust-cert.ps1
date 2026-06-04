# =============================================================================
#  trust-cert.ps1
#  Run ONCE on each editor's machine, in PowerShell *as Administrator*.
#
#  Imports the PUBLIC vTrack code-signing certificate so Windows recognises
#  the signature. After this, installing/running vTrack shows the verified
#  "Vyral Digital" publisher name instead of "Unknown Publisher", and Windows
#  can confirm the binary was not modified since it was signed.
#
#  Distribute ONLY the .cer file to clients — never the .pfx.
# =============================================================================

param(
  [string]$CerPath = "$PSScriptRoot\..\certs\vtrack-codesign.cer"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $CerPath)) {
  throw "Certificate not found: $CerPath  (pass -CerPath <path to vtrack-codesign.cer>)"
}

# Trust the cert as a root authority (so the chain validates) ...
Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
Write-Host "Imported into Trusted Root Certification Authorities."

# ... and as a trusted publisher (so signed code is recognised silently).
Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher" | Out-Null
Write-Host "Imported into Trusted Publishers."

Write-Host ""
Write-Host "Done. vTrack's signature is now trusted on this machine."
