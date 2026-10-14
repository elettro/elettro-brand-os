# Elettro Step 9 – local-only provisioning for two independent read-only MCP clients
# Works in Windows PowerShell 5.1+; generate tokens LOCALLY, never in ChatGPT.
# Tokens are stored using Windows DPAPI under the current user's LOCALAPPDATA.
param(
  [ValidateSet("Create","ExpandBrands","CopyAwsJson","TestClaudeCode","TestClaudeWeb","ConnectClaudeCode","CopyClaudeWebHeader","EmitCodeHeaders")]
  [string] $Action = "Create"
)
$ErrorActionPreference = "Stop"
$Dir = Join-Path $env:LOCALAPPDATA "ElettroMCP"
$ConfigFile = Join-Path $Dir "aws-readonly-clients.json"
$Endpoint = "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp"
$Brands = @("stashbox","elettro","solarmeister","weightlossdavie","neckermann-strom","therasbox")
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
  $secure = ConvertTo-SecureString ((Get-Content -Raw $path).Trim())
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
  # Keep a stable local copy for the Claude Code headersHelper to call.
  $helperFile=Join-Path $Dir "step9-readonly-clients.ps1"
  if ($PSCommandPath -ne $helperFile) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $helperFile -Force
  }
  $codeToken=$null; $webToken=$null
  Write-Host "CREATED two independent read-only credentials. Raw tokens were NOT printed or saved as plaintext."
  Write-Host "AWS SSM JSON (hashes only): $ConfigFile"
  Write-Host "AWS SSM parameter: /amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON"
  Write-Host "NEXT: Run -Action CopyAwsJson, paste into AWS Systems Manager > Parameter Store > SecureString."
  break
 }
 "ExpandBrands" {
  if (-not (Test-Path $ConfigFile)) { throw "Local configuration missing. Run Create first." }
  $cfg = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
  $clients = @($cfg.clients)
  $ids = @($clients | ForEach-Object { $_.id })
  if ($clients.Count -ne 2 -or $ids -notcontains "claude_code" -or $ids -notcontains "claude_web") {
    throw "Expected the existing Claude Code and Claude.ai credentials; refusing to modify unexpected config."
  }
  foreach ($client in $clients) {
    if ($client.tokenSha256 -notmatch '^[0-9a-f]{64}
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
   $localConfig = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
   $expectedBrands = @($localConfig.clients | Where-Object { $_.id -eq "claude_code" } |
     ForEach-Object { $_.brandSlugs } | ForEach-Object { $_ })
   $grantedBrands = @($tools[0].inputSchema.properties.brandSlug.enum)
   if (@(Compare-Object -ReferenceObject $expectedBrands -DifferenceObject $grantedBrands).Count -gt 0) {
     throw "AWS and local Claude Code brand permissions do not match. Update the existing SSM parameter value and retry."
   }
   $id = 4
   foreach ($brand in $expectedBrands) {
     $result=Mcp-Call $token $id "tools/call" @{
       name="elettro_search_assets";arguments=@{brandSlug=$brand;limit=1}
     }
     if ($result.result.isError) { throw "Expected brand access failed: $brand" }
     $id++
   }
   $denied=Mcp-Call $token $id "tools/call" @{
     name="elettro_search_assets";arguments=@{brandSlug="outside-elettro";limit=1}
   }
   if (-not $denied.result.isError) { throw "Unexpected unrecognized-brand access: fail closed" }
   Write-Host "PASS: Claude Code MCP, six read-only tools, $($expectedBrands.Count) authorized brands, unknown brand denied."
  } finally { $token=$null }
  break
 }
 "TestClaudeWeb" {
  $token=Unprotect-Token "claude_web"
  try {
   $init=Mcp-Call $token 11 "initialize" @{
    protocolVersion="2025-06-18";capabilities=@{};clientInfo=@{name="elettro-web-smoke";version="1"}
   }
   if ($init.result.serverInfo.name -ne "elettro-ai-gateway") { throw "Unexpected MCP server" }
   $catalog=Mcp-Call $token 12 "tools/list" @{}
   $tools=@($catalog.result.tools)
   if ($tools.Count -ne 6) { throw "Expected precisely 6 read-only tools. Got $($tools.Count)" }
   if (@($tools | Where-Object { $_.annotations.readOnlyHint -ne $true }).Count) {
    throw "A tool was not marked read-only"
   }
   $localConfig = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
   $expectedBrands = @($localConfig.clients | Where-Object { $_.id -eq "claude_web" } |
     ForEach-Object { $_.brandSlugs } | ForEach-Object { $_ })
   $grantedBrands = @($tools[0].inputSchema.properties.brandSlug.enum)
   if (@(Compare-Object -ReferenceObject $expectedBrands -DifferenceObject $grantedBrands).Count -gt 0) {
     throw "AWS and local Claude.ai brand permissions do not match."
   }
   Write-Host "PASS: Claude.ai separate credential, six read-only tools, $($expectedBrands.Count) authorized brands."
  } finally { $token=$null }
  break
 }
 "EmitCodeHeaders" {
  # Invoked only by Claude Code at connection time. Emits one JSON header
  # object on stdout; the stored Claude config never contains a raw token.
  $token=Unprotect-Token "claude_code"
  try {
   $headers=@{Authorization=("Bearer " + $token)} | ConvertTo-Json -Compress
   [Console]::Out.WriteLine($headers)
  } finally { $token=$null }
  break
 }
 "ConnectClaudeCode" {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI not found. Install/sign in to Claude Code first." }
  $installedScript=Join-Path $Dir "step9-readonly-clients.ps1"
  if (-not (Test-Path $installedScript)) { throw "Protected credential helper not installed. Run -Action Create first." }
  # Modern Claude Code supports headersHelper in a remote HTTP server.
  # It reads the DPAPI-protected credential at connection time, without storing
  # the plaintext bearer token in the Claude configuration or shell history.
  $helperCommand='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedScript + '" -Action EmitCodeHeaders'
  $serverJson=@{type="http";url=$Endpoint;headersHelper=$helperCommand} | ConvertTo-Json -Compress
  & claude mcp add-json elettro-dev $serverJson --scope user
  if ($LASTEXITCODE -ne 0) { throw "Claude Code rejected the MCP configuration. Confirm Claude Code supports headersHelper." }
  Write-Host "Claude Code configuration added without storing the raw token in its config."
  Write-Host "In Claude Code use /mcp to confirm connection. Do not upload your local DPAPI files."
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
 -or
        @($client.permissions).Count -ne 2 -or
        @($client.permissions) -notcontains "assets:read" -or
        @($client.permissions) -notcontains "folders:read") {
      throw "Unexpected credential or permissions configuration; refusing to modify."
    }
  }
  $backup = Join-Path $Dir "aws-readonly-clients.pre-allbrands.json"
  if (-not (Test-Path $backup)) {
    Copy-Item -LiteralPath $ConfigFile -Destination $backup
  }
  foreach ($client in $clients) { $client.brandSlugs = @($Brands) }
  $cfg | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
  Write-Host "UPDATED: Both existing Claude credentials now have READ-ONLY access to all six brands in the local hash-only configuration."
  Write-Host "Neither bearer token nor either token hash was changed. The AWS parameter is NOT updated yet."
  Write-Host "NEXT: Run -Action CopyAwsJson, then edit (do not recreate) the existing AWS SSM SecureString value."
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
 "TestClaudeWeb" {
  $token=Unprotect-Token "claude_web"
  try {
   $init=Mcp-Call $token 11 "initialize" @{
    protocolVersion="2025-06-18";capabilities=@{};clientInfo=@{name="elettro-web-smoke";version="1"}
   }
   if ($init.result.serverInfo.name -ne "elettro-ai-gateway") { throw "Unexpected MCP server" }
   $catalog=Mcp-Call $token 12 "tools/list" @{}
   $tools=@($catalog.result.tools)
   if ($tools.Count -ne 6) { throw "Expected precisely 6 read-only tools. Got $($tools.Count)" }
   if (@($tools | Where-Object { $_.annotations.readOnlyHint -ne $true }).Count) {
    throw "A tool was not marked read-only"
   }
   Write-Host "PASS: Claude.ai separate credential authenticated with precisely six read-only tools."
  } finally { $token=$null }
  break
 }
 "EmitCodeHeaders" {
  # Invoked only by Claude Code at connection time. Emits one JSON header
  # object on stdout; the stored Claude config never contains a raw token.
  $token=Unprotect-Token "claude_code"
  try {
   $headers=@{Authorization=("Bearer " + $token)} | ConvertTo-Json -Compress
   [Console]::Out.WriteLine($headers)
  } finally { $token=$null }
  break
 }
 "ConnectClaudeCode" {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI not found. Install/sign in to Claude Code first." }
  $installedScript=Join-Path $Dir "step9-readonly-clients.ps1"
  if (-not (Test-Path $installedScript)) { throw "Protected credential helper not installed. Run -Action Create first." }
  # Modern Claude Code supports headersHelper in a remote HTTP server.
  # It reads the DPAPI-protected credential at connection time, without storing
  # the plaintext bearer token in the Claude configuration or shell history.
  $helperCommand='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedScript + '" -Action EmitCodeHeaders'
  $serverJson=@{type="http";url=$Endpoint;headersHelper=$helperCommand} | ConvertTo-Json -Compress
  & claude mcp add-json elettro-dev $serverJson --scope user
  if ($LASTEXITCODE -ne 0) { throw "Claude Code rejected the MCP configuration. Confirm Claude Code supports headersHelper." }
  Write-Host "Claude Code configuration added without storing the raw token in its config."
  Write-Host "In Claude Code use /mcp to confirm connection. Do not upload your local DPAPI files."
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
