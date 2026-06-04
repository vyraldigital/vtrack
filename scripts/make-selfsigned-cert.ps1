# =============================================================================
#  make-selfsigned-cert.ps1
#  Run ONCE on a Windows machine, in PowerShell *as Administrator*.
#
#  Creates a self-signed code-signing certificate used to sign vTrack builds.
#  This is FREE. It does NOT remove the SmartScreen "unknown app" warning for
#  internet-downloaded copies (only a paid CA cert with reputation does that),
#  BUT once the matching public cert is trusted on a machine (see trust-cert.ps1)
#  the Windows UAC / install dialog shows your verified publisher name instead
#  of the red "Unknown Publisher", and Windows can verify the binary wasn't
#  tampered with.
# =============================================================================

param(
  [string]$Subject      = "CN=Vyral Digital, O=Vyral Digital, C=PK",
  [string]$FriendlyName = "Vyral Digital Code Signing",
  [int]   $ValidYears   = 5,
  [string]$OutDir       = "$PSScriptRoot\..\certs"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 1. Create the code-signing certificate in the current user's store.
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -FriendlyName $FriendlyName `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears($ValidYears)

Write-Host "Created certificate. Thumbprint: $($cert.Thumbprint)"

# 2. Ask for a password to protect the private key (.pfx).
$pwd = Read-Host "Enter a password to protect the .pfx (you'll need it at build time)" -AsSecureString

# 3. Export the PFX  ->  PRIVATE key. KEEP SECRET. Used only to sign builds.
$pfxPath = Join-Path $OutDir "vtrack-codesign.pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
Write-Host "Exported PFX (KEEP SECRET): $pfxPath"

# 4. Export the CER  ->  PUBLIC cert. Safe to distribute to editor machines.
$cerPath = Join-Path $OutDir "vtrack-codesign.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Write-Host "Exported CER (distribute to clients): $cerPath"

Write-Host ""
Write-Host "------------------------------------------------------------------"
Write-Host "To build a SIGNED installer, set these env vars then run package:"
Write-Host ""
Write-Host "  `$env:WIN_CSC_LINK = '$pfxPath'"
Write-Host "  `$env:WIN_CSC_KEY_PASSWORD = '<the password you just entered>'"
Write-Host "  npm run package"
Write-Host "------------------------------------------------------------------"
