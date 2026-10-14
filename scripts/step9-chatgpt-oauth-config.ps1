# Elettro — append dedicated ChatGPT OAuth settings to existing hash-only
# Windows configuration. Existing Claude tokens and hashes are never changed.
# Assumes a NEW Cognito public app client, authorization code + PKCE S256.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^us-east-1_[A-Za-z0-9]+$')][string]$UserPoolId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{10,128}$')][string]$PublicClientId
)
$ErrorActionPreference='Stop'
$dir=Join-Path $env:LOCALAPPDATA 'ElettroMCP'
$file=Join-Path $dir 'aws-readonly-clients.json'
if(-not (Test-Path -LiteralPath $file)){throw 'Existing hash-only MCP configuration missing. Stop; do not generate fresh credentials.'}
$config=Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
if($config -isnot [pscustomobject] -or $null -eq $config.clients){throw 'Unexpected local configuration; no changes made.'}
$clients=@($config.clients)
$ids=@($clients | ForEach-Object { $_.id })
if($clients.Count -ne 2 -or $ids -notcontains 'claude_code' -or $ids -notcontains 'claude_web'){
  throw 'Expected the existing two Claude credentials; no changes made.'
}
foreach($entry in $clients){
  if($entry.tokenSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
      @($entry.permissions).Count -ne 2 -or
      @($entry.permissions) -notcontains 'assets:read' -or
      @($entry.permissions) -notcontains 'folders:read' -or
      @($entry.brandSlugs).Count -ne 6){
    throw 'Existing Claude permissions differ from six-brand READ-ONLY policy; no changes made.'
  }
}
if($null -ne $config.PSObject.Properties['chatgptOauth']){
  throw 'ChatGPT OAuth entry already exists. Refusing to overwrite it automatically.'
}
$backup=Join-Path $dir ('aws-readonly-clients.pre-chatgpt-oauth-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
Copy-Item -LiteralPath $file -Destination $backup
$issuer='https://cognito-idp.us-east-1.amazonaws.com/'+$UserPoolId
$config | Add-Member -MemberType NoteProperty -Name chatgptOauth -Value ([pscustomobject]@{
  enabled=$true;issuer=$issuer;clientId=$PublicClientId
})
$new=$config | ConvertTo-Json -Depth 16
if($new.Length -ge 4090){throw 'Standard SSM parameter size limit may be exceeded. No changes made.'}
$new | Set-Content -LiteralPath $file -Encoding UTF8
Write-Host 'SUCCESS: Added dedicated ChatGPT Cognito OAuth configuration to local HASH-ONLY JSON.'
Write-Host 'Claude token hashes and all-six-brand read-only grants are unchanged.'
Write-Host 'AWS has NOT been updated. Review the setup guide before replacing the existing SSM value.'
