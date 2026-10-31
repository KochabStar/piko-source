#requires -Version 5.1
param([ValidateSet('install','remove')][string]$Action,[Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Data)
$ErrorActionPreference='Stop'
# Generated recipe data: no application DLL is loaded or unregistered in-process.
$values=ConvertFrom-Json @'
@@REGISTRY_VALUES@@
'@
$Root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
$Data=[IO.Path]::GetFullPath($Data)
$journal=Join-Path $Data 'shell-registration.json'
function Same($a,$b) { if($null -eq $a -or $null -eq $b){return $null -eq $a -and $null -eq $b};return $a.kind -eq $b.kind -and [string]$a.value -ceq [string]$b.value }
function Current($entry) {
 $k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($entry.key)
 try {if(!$k -or !($k.GetValueNames() -contains $entry.name)){return $null};return @{kind=$k.GetValueKind($entry.name).ToString();value=$k.GetValue($entry.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}finally{if($k){$k.Dispose()}}
}
function Save-Record($record) {
 $null=[IO.Directory]::CreateDirectory($Data)
 $temp=$journal+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 try {
  [IO.File]::WriteAllText($temp,($record|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
  if([IO.File]::Exists($journal)){[IO.File]::Replace($temp,$journal,[NullString]::Value)}else{[IO.File]::Move($temp,$journal)}
 }finally{if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
$record=$null
if(Test-Path -LiteralPath $journal){
 $record=Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json
 if($record.schemaVersion -ne 2 -or $record.state -notin @('installing','installed','removing','removed')){throw 'Unsupported system registration ownership receipt; explicitly remove the previous recipe first'}
 if($record.state -ne 'removed' -and $record.root -ine $Root){throw 'Another version owns Shell registration; use piko system --upgrade to remove it first'}
}
if($Action -eq 'remove' -and (!$record -or $record.root -ine $Root)){throw 'No owned system registration record for this version'}
if($record -and $record.root -ine $Root){$record=$null}
$entries=@()
foreach($v in $values){
 $desired=@{kind=$v.kind;value=$v.value.Replace('{{root}}',$Root)}
 $prior=@(if($record){$record.entries|Where-Object{$_.key -ceq $v.key -and $_.name -ceq $v.name}})
 if($record -and $prior.Count -ne 1){throw 'System registration receipt differs from recipe'}
 $now=Current $v
 if($prior.Count){
  if(!(Same $prior[0].after $desired)){throw 'System registration recipe changed; preserve journal'}
  if(!(Same $now $prior[0].after) -and !(Same $now $prior[0].before)){throw ('External registry drift: '+$v.key)}
 }elseif($null -ne $now){throw ('Existing external Shell registration: '+$v.key)}
 $entries+=@{key=$v.key;name=$v.name;before=if($prior.Count){$prior[0].before}else{$null};after=$desired}
}
if($record -and @($record.entries).Count -ne $entries.Count){throw 'System registration receipt has undeclared resources'}
if($Action -eq 'install'){
 foreach($relative in @('bin\TortoiseStub.dll','bin\TortoiseSVN.dll','bin\TSVNCache.exe','Common\TortoiseOverlays\TortoiseOverlays.dll')){
  $file=Join-Path $Root $relative
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw ('Required Shell payload missing: '+$relative)}
 }
}
# Record intent before writes; retries compare every value to before/after snapshots.
$phase=if($Action -eq 'install'){'installing'}else{'removing'}
Save-Record @{schemaVersion=2;root=$Root;state=$phase;entries=$entries}
foreach($entry in $entries){
 $value=if($Action -eq 'install'){$entry.after}else{$entry.before}
 $now=Current $entry
 if(Same $now $value){continue}
 if(!(Same $now $entry.after) -and !(Same $now $entry.before)){throw ('Registry changed during write: '+$entry.key)}
 $k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($entry.key,$true)
 try {
  if($null -eq $value){if($k){$k.DeleteValue($entry.name,$false)}}
  else{if(!$k){$k=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($entry.key)};$kind=[Microsoft.Win32.RegistryValueKind]::$($value.kind);$k.SetValue($entry.name,[string]$value.value,$kind)}
 }finally{if($k){$k.Dispose()}}
}
$phase=if($Action -eq 'install'){'installed'}else{'removed'}
Save-Record @{schemaVersion=2;root=$Root;state=$phase;entries=$entries}
# No fixed CommonProgramFiles junction, regsvr32, old-file deletion or process kill.
# Existing processes keep the old version mapped until they exit. The package
# manager retains old versions and defers their cleanup while images are in use.
Write-Output 'Version-specific Shell registration updated. Existing processes may use the old version until sign-out/restart. Old files were not deleted and no process was restarted.'
