# Elettro DEV — dedicated ChatGPT PRIVATE plugin credential.
# No plaintext token is printed or written to JSON, AWS, GitHub, or Dropbox.
# Existing Claude and Cognito records are preserved. Run as SAME Windows user.
param([ValidateSet("Create","CopyToken","CopyHeader","CopyAwsJson","EnableWrites","Test")][string]$Action="Create")
$ErrorActionPreference="Stop"
$Dir=Join-Path $env:LOCALAPPDATA "ElettroMCP"
$ConfigPath=Join-Path $Dir "aws-readonly-clients.json"
$TokenFile=Join-Path $Dir "chatgpt_private.dpapi"
$Endpoint="https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp"
$Brands=@("stashbox","elettro","solarmeister","weightlossdavie","neckermann-strom","therasbox")
$Read=@("assets:read","folders:read")
$Write=@("assets:read","folders:read","assets:write","folders:write","assets:upload")

function ReadConfig {
 if(-not(Test-Path -LiteralPath $ConfigPath)){throw "Existing HASH-ONLY config missing. Stop; do not regenerate Claude keys."}
 $cfg=Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
 if($null -eq $cfg.clients -or @($cfg.clients).Count -lt 2){throw "Invalid pre-existing Claude credential configuration."}
 foreach($id in @("claude_code","claude_web")){
  $matched=@($cfg.clients | Where-Object {$_.id -eq $id})
  if($matched.Count -ne 1 -or $matched[0].tokenSha256 -notmatch "^[0-9a-f]{64}$"){
   throw "Existing Claude client $id missing or invalid; no changes made."
  }
 }
 return $cfg
}
function SaveConfig($cfg){
 $backup=Join-Path $Dir ("aws-mcp-clients.pre-chatgpt-private-"+(Get-Date -Format "yyyyMMdd-HHmmss-fff")+".json")
 Copy-Item -LiteralPath $ConfigPath -Destination $backup
 $next=$cfg | ConvertTo-Json -Depth 20
 if([Text.Encoding]::UTF8.GetByteCount($next) -gt 4096){
  throw "SSM standard parameter size limit exceeded. No changes made."
 }
 $utf8=New-Object System.Text.UTF8Encoding($false)
 [System.IO.File]::WriteAllText($ConfigPath,$next,$utf8)
 Write-Host "Hash-only backup saved locally."
}
function Token {
 if(-not(Test-Path -LiteralPath $TokenFile)){throw "ChatGPT protected key not found; run -Action Create first."}
 $secure=(Get-Content -Raw -LiteralPath $TokenFile).Trim() | ConvertTo-SecureString
 $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
 finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
}
switch($Action){
 "Create" {
  $cfg=ReadConfig
  if((Test-Path -LiteralPath $TokenFile) -or @($cfg.clients | Where-Object {$_.id -eq "chatgpt_private"}).Count){
   throw "ChatGPT credential already exists; refusing to regenerate or duplicate."
  }
  $raw=New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($raw)
  $token=[Convert]::ToBase64String($raw).TrimEnd("=").Replace("+","-").Replace("/","_")
  $sha=[Security.Cryptography.SHA256]::Create()
  $hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token)))).Replace("-","").ToLowerInvariant()
  $cfg.clients=@($cfg.clients)+@([pscustomobject]@{
   id="chatgpt_private";tokenSha256=$hash;brandSlugs=$Brands;
   permissions=$Read;enabled=$true
  })
  $token | ConvertTo-SecureString -AsPlainText -Force |
   ConvertFrom-SecureString | Set-Content -LiteralPath $TokenFile -Encoding ASCII
  try{SaveConfig $cfg}
  catch{
   Remove-Item -LiteralPath $TokenFile -Force
   throw
  }
  Write-Host "SUCCESS: Created separate ChatGPT PRIVATE credential (READ-ONLY)."
  Write-Host "Claude credentials unchanged. AWS has NOT been updated."
  Write-Host "NEXT: -Action CopyAwsJson, paste hash-only JSON in existing AWS SecureString."
  break
 }
 "CopyAwsJson" {
  $cfg=ReadConfig
  if(@($cfg.clients | Where-Object {$_.id -eq "chatgpt_private"}).Count -ne 1){
   throw "ChatGPT credential not found."
  }
  Get-Content -Raw -LiteralPath $ConfigPath | Set-Clipboard
  Write-Host "Copied HASH-ONLY configuration to clipboard. Paste only into existing AWS MCP SecureString Value."
  break
 }
 "CopyToken" {
  $token=Token
   $token | Set-Clipboard
  Write-Host "Copied private ChatGPT API KEY to clipboard without displaying it. Paste only in protected plugin connection prompt."
  break
 }
 "CopyHeader" {
  $token=Token
  ("Bearer "+$token) | Set-Clipboard
  Write-Host "Copied ChatGPT Authorization HEADER with Bearer prefix without displaying it."
  break
 }
 "EnableWrites" {
  $cfg=ReadConfig
  $matched=@($cfg.clients | Where-Object {$_.id -eq "chatgpt_private"})
  if($matched.Count -ne 1){throw "ChatGPT credential missing; no changes made."}
  $entry=$matched[0]
  if(@($entry.permissions).Count -ne 2 -or
     @($entry.permissions) -notcontains "assets:read" -or
     @($entry.permissions) -notcontains "folders:read"){
   throw "ChatGPT permissions are not the expected READ-only starting point; no changes made."
  }
  if(@($entry.brandSlugs).Count -ne 6){
   throw "ChatGPT brand grants are not the expected six; no changes made."
  }
  $entry.permissions=$Write
  SaveConfig $cfg
  Write-Host "SUCCESS: Added controlled metadata, folder and upload permissions ONLY to ChatGPT hash-only grant."
  Write-Host "Claude unchanged. AWS not updated; copy hash-only config into existing SecureString to activate."
  break
 }
 "Test" {
  $token=Token
  $payload=@{jsonrpc="2.0";id=1;method="tools/list";params=@{}} | ConvertTo-Json -Compress
  $result=Invoke-RestMethod -Uri $Endpoint -Method Post -ContentType "application/json" -Headers @{authorization=("Bearer "+$token)} -Body $payload -TimeoutSec 30
  if(-not $result.result.tools){throw "ChatGPT tool listing unavailable"}
  $tools=@($result.result.tools)
  $names=@($tools|ForEach-Object{$_.name})
  if($names -notcontains "elettro_prepare_file_intake"){throw "ChatGPT file-intake preview tool unavailable"}
  Write-Host ("PASS: ChatGPT private token authenticated, "+$tools.Count+" tools available.")
  Write-Host ("Write upload enabled: "+($names -contains "elettro_save_chat_file_to_dropbox"))
  break
 }
}
