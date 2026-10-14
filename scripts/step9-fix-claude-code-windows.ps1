# Elettro DEV — Claude Code Windows MCP registration fix.
# Preserves your encrypted tokens and existing Claude configuration.
# Adds only the user-scoped 'elettro-dev' entry. No AWS or Dropbox writes.
param([ValidateSet('Install','Verify')][string]$Action='Install')
$ErrorActionPreference='Stop'
$endpoint='https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp'
$localDir=Join-Path $env:LOCALAPPDATA 'ElettroMCP'
$helper=Join-Path $localDir 'step9-readonly-clients.ps1'
$protectedToken=Join-Path $localDir 'claude_code.dpapi'
$config=Join-Path $HOME '.claude.json'

if($env:CLAUDE_CONFIG_DIR){
  throw 'Nondefault CLAUDE_CONFIG_DIR is configured. Stop here so we do not edit the wrong Claude config.'
}
if(-not(Test-Path -LiteralPath $helper)){
  throw 'The local credential helper is missing. Do not recreate tokens; ask to repair the helper first.'
}
if(-not(Test-Path -LiteralPath $protectedToken)){
  throw 'The protected Claude Code credential is missing. Do not recreate tokens.'
}
$helperContent=Get-Content -Raw -LiteralPath $helper
if($helperContent -notmatch '"EmitCodeHeaders"'){
  throw 'The installed credential helper does not support EmitCodeHeaders. Stop and request an updated helper.'
}
$headerCommand='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+$helper+'" -Action EmitCodeHeaders'
function Read-Config {
  if(Test-Path -LiteralPath $config){
    $raw=Get-Content -Raw -Encoding UTF8 -LiteralPath $config
    if([string]::IsNullOrWhiteSpace($raw)){throw 'Existing .claude.json is empty; no changes made.'}
    $data=$raw | ConvertFrom-Json
    if($null -eq $data -or $data -isnot [pscustomobject]){throw 'Existing Claude configuration must be a JSON object.'}
    return $data
  }
  return [pscustomobject]@{}
}
function Get-Entry($data) {
  if($null -eq $data.mcpServers){return $null}
  if($data.mcpServers -isnot [pscustomobject]){throw 'mcpServers is not a JSON object. No changes made.'}
  $property=$data.mcpServers.PSObject.Properties['elettro-dev']
  if($null -eq $property){return $null}
  return $property.Value
}
$data=Read-Config
$existing=Get-Entry $data
if($Action -eq 'Verify'){
  if($null -eq $existing){throw 'elettro-dev is not registered yet.'}
  if($existing.type -ne 'http' -or $existing.url -ne $endpoint -or $existing.headersHelper -ne $headerCommand){
    throw 'elettro-dev exists, but its URL or secure header helper does not match the expected settings.'
  }
  if($existing.PSObject.Properties['headers']){throw 'Unexpected static headers in the config.'}
  Write-Host 'PASS: elettro-dev is configured for HTTP with a local encrypted-credential helper. No token is stored in Claude configuration.'
  exit 0
}
if($null -ne $existing){
  if($existing.type -eq 'http' -and $existing.url -eq $endpoint -and $existing.headersHelper -eq $headerCommand -and -not $existing.PSObject.Properties['headers']){
    Write-Host 'Already registered: elettro-dev uses the secure dynamic headers helper. No changes made.'
    exit 0
  }
  throw 'An elettro-dev entry already exists with different settings. No changes made. Ask for review before changing it.'
}
if($null -eq $data.mcpServers){
  $data | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{}) -Force
}
$entry=[pscustomobject]@{type='http';url=$endpoint;headersHelper=$headerCommand}
$data.mcpServers | Add-Member -MemberType NoteProperty -Name 'elettro-dev' -Value $entry
$serialized=$data | ConvertTo-Json -Depth 100
$checked=$serialized | ConvertFrom-Json
if($checked.mcpServers.'elettro-dev'.headersHelper -ne $headerCommand){throw 'Configuration self-check failed; no changes made.'}
$parent=Split-Path -Parent $config
if(-not (Test-Path -LiteralPath $parent)){throw 'Cannot find Claude user directory.'}
$temp=Join-Path $parent ('.claude.json.elettro-step9-'+[guid]::NewGuid().ToString('N')+'.tmp')
$utf8=New-Object System.Text.UTF8Encoding($false)
try {
  [System.IO.File]::WriteAllText($temp,$serialized,$utf8)
  $disk=(Get-Content -Raw -LiteralPath $temp | ConvertFrom-Json)
  if($disk.mcpServers.'elettro-dev'.headersHelper -ne $headerCommand){throw 'Temporary file verification failed.'}
  if(Test-Path -LiteralPath $config){
    $backup=Join-Path $parent ('.claude.json.elettro-step9-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
    [System.IO.File]::Replace($temp,$config,$backup)
    Write-Host 'Existing Claude user configuration backed up before modification.'
  }else{
    [System.IO.File]::Move($temp,$config)
  }
}finally{
  if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}
}
$final=Read-Config
if($final.mcpServers.'elettro-dev'.headersHelper -ne $headerCommand){throw 'Config was written but verification failed. Stop and request help.'}
Write-Host 'SUCCESS: elettro-dev registered in Claude Code user settings with secure dynamic authentication.'
Write-Host 'No token was printed or saved in plaintext. All six brands remain read-only.'
Write-Host 'NEXT: Open Claude Code and type /mcp to check elettro-dev status.'
