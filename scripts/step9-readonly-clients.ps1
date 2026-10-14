# Elettro Step 9 – local-only provisioning for two independent read-only MCP clients
# Works in Windows PowerShell 5.1+; generate tokens LOCALLY, never in ChatGPT.
# Tokens are stored using Windows DPAPI under the current user's LOCALAPPDATA.
param(
  [ValidateSet("Create","CopyAwsJson","TestClaudeCode","ConnectClaudeCode","CopyClaudeWebHeader")]
  [string] $Action = "Create"
)
$ErrorActionPreference = "Stop"
$Dir = Join-Path $env:LOCALAPPDATA "ElettroMCP"
$ConfigFile = Join-Path $Dir "aws-readonly-clients.json"
$Endpoint = "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp"
$Brands = @("stashbox","elettro")
$Permissions = @("assets:read","folders:read")

function New-PrivateToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) }
  finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
}
function Sha256Hex([string] $Token) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))).Replace("-","").ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Protect-Token([string] $Token, [string] $Client) {
  $secure = ConvertTo-SecureString -String $Token -AsPlainText -Force
  $encrypted = ConvertFrom-SecureString $secure
  Set-Content -Path (Join-Path $Dir ($Client + ".dpapi")) -Value $encrypted -Encoding Ascii
}
function Unprotect-Token([string] $Client) {
  $path = Join-Path $Dir ($Client + ".dpapi")
  if (-not (Test-Path $path)) { throw "Missing local protected token. Run -Action Create first." }
  $secure = ConvertTo-SecureString (Get-Content -Raw $path)
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Mcp-Call([string]$Token,[int]$Id,[string]$Method,[object]$Params) {
  $body = @{jsonrpc="2.0";id=$Id;method=$Method;params=$Params} | ConvertTo-Json -Depth 12 -Compress
  $headers = @{Authorization="Bearer $Token";Accept="application/json, text/event-stream"}
  return Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 25
}

switch ($Action) {
 "Create" {
  if (Test-Path $ConfigFile) { throw "Provisioning file already exists. Refusing to overwrite existing credentials." }
  if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir | Out-Null }
  if ((Test-Path (Join-Path $Dir "claude_code.dpapi")) -or (Test-Path (Join-Path $Dir "claude_web.dpapi"))) {
   throw "Existing protected tokens found. Refusing to overwrite."
  }
  $codeToken=New-PrivateToken
  $webToken=New-PrivateToken
  Protect-Token $codeToken "claude_code"
  Protect-Token $webToken "claude_web"
  $cfg=@{
   clients=@(
    @{ id="claude_code"; tokenSha256=(Sha256Hex $codeToken); brandSlugs=$Brands; permissions=$Permissions; enabled=$true },
    @{ id="claude_web"; tokenSha256=(Sha256Hex $webToken); brandSlugs=$Brands; permissions=$Permissions; enabled=$true }
   )
  } | ConvertTo-Json -Depth 8
  Set-Content -Path $ConfigFile -Value $cfg -Encoding UTF8
  $codeToken=$null; $webToken=$null
  Write-Host "CREATED two independent read-only credentials. Raw tokens were NOT printed or saved as plaintext."
  Write-Host "AWS SSM JSON (hashes only): $ConfigFile"
  Write-Host "AWS SSM parameter: /amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON"
  Write-Host "NEXT: Run -Action CopyAwsJson, paste into AWS Systems Manager > Parameter Store > SecureString."
  break
 }
 "CopyAwsJson" {
  if (-not (Test-Path $ConfigFile)) { throw "Run -Action Create first." }
  (Get-Content -Raw $ConfigFile) | Set-Clipboard
  Write-Host "Copied HASH-ONLY config to clipboard. Paste into the SSM SecureString VALUE. No tokens are included."
  break
 }
 "TestClaudeCode" {
  $token=Unprotect-Token "claude_code"
  try {
   $init=Mcp-Call $token 1 "initialize" @{
    protocolVersion="2025-06-18";capabilities=@{};clientInfo=@{name="elettro-windows-smoke";version="1"}
   }
   if ($init.result.serverInfo.name -ne "elettro-ai-gateway") { throw "Unexpected MCP server" }
   $catalog=Mcp-Call $token 2 "tools/list" @{}
   $tools=@($catalog.result.tools)
   if ($tools.Count -ne 6) { throw "Expected precisely 6 read-only tools. Got $($tools.Count)" }
   if (@($tools | Where-Object { $_.annotations.readOnlyHint -ne $true }).Count) {
    throw "A tool was not marked read-only"
   }
   $query=Mcp-Call $token 3 "tools/call" @{
     name="elettro_search_assets";arguments=@{brandSlug="stashbox";query="SE53F9";limit=5}
   }
   if ($query.result.isError) { throw "Authorized search failed" }
   $denied=Mcp-Call $token 4 "tools/call" @{
     name="elettro_search_assets";arguments=@{brandSlug="solarmeister";limit=1}
   }
   if (-not $denied.result.isError) { throw "Unexpected cross-brand access: fail closed" }
   Write-Host "PASS: authenticated MCP, six read-only tools, Stashbox asset search, cross-brand access denied."
  } finally { $token=$null }
  break
 }
 "ConnectClaudeCode" {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI not found. Install/sign in to Claude Code first." }
  $token=Unprotect-Token "claude_code"
  try {
    & claude mcp add --transport http --scope user elettro-dev $Endpoint --header ("Authorization: Bearer " + $token)
    if ($LASTEXITCODE -ne 0) { throw "Claude Code rejected the MCP configuration" }
  } finally { $token=$null }
  Write-Host "Claude Code configuration added. In Claude Code use /mcp to check connection."
  Write-Host "DO NOT paste output of 'claude mcp get' into chat; it may reveal the auth header."
  break
 }
 "CopyClaudeWebHeader" {
  $token=Unprotect-Token "claude_web"
  try { ("Bearer " + $token) | Set-Clipboard }
  finally { $token=$null }
  Write-Host "Copied Claude.ai Authorization header VALUE to clipboard. Do NOT paste it into this chat."
  Write-Host "In Claude.ai Custom Connector use key 'Authorization' and paste clipboard as its value."
  break
 }
}
