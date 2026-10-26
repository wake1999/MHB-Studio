# Sync the local studio/ tree to the copy running on the server (/opt/ekko-src).
#
# The archive is produced through git (a throwaway index), not by tarring the
# working tree: that keeps LF line endings and the executable bits the repo
# records, and it still includes uncommitted edits. node_modules / dist / server
# data stay out because they are untracked. After the sync vite (HMR) and
# nodemon reload by themselves.
#
# Usage:
#   .\deploy-studio.ps1                 # overwrite; files deleted locally stay on the server
#   .\deploy-studio.ps1 -Delete         # also remove remote files that no longer exist locally
#   .\deploy-studio.ps1 -Server root@1.2.3.4
param(
  [string]$Server = $env:MHB_STUDIO_SERVER,
  [switch]$Delete
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $root 'studio'))) { throw 'studio/ not found next to this script' }

if (-not $Server) {
  $localCfg = Join-Path $root '.deploy.local'
  if (Test-Path $localCfg) { $Server = (Get-Content $localCfg -TotalCount 1).Trim() }
}
if (-not $Server) { throw 'No server configured: set $env:MHB_STUDIO_SERVER or put "user@host" in .deploy.local' }

$tar = Join-Path $env:TEMP 'mhb-studio-sync.tgz'
$tmpIndex = Join-Path $env:TEMP 'mhb-studio-sync.index'
$remoteTar = '/root/ekko-upload/studio-sync.tgz'
$remoteScript = '/root/ekko-upload/sync-apply.sh'

Write-Host '[1/3] packing studio/ through git (LF endings, uncommitted edits included)' -ForegroundColor Cyan
if (Test-Path $tar) { Remove-Item -Force $tar }
if (Test-Path $tmpIndex) { Remove-Item -Force $tmpIndex }

$dirty = (git -C $root status --porcelain -- studio | Measure-Object).Count
Write-Host ("      local changes in studio/: {0}" -f $dirty) -ForegroundColor DarkGray

$env:GIT_INDEX_FILE = $tmpIndex
try {
  git -C $root read-tree HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git read-tree failed' }
  git -C $root add -A -- studio
  if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
  $tree = (git -C $root write-tree).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $tree) { throw 'git write-tree failed' }

  # Windows has no exec bit, so git add may flatten 100755 to 100644; put the
  # modes back from HEAD before archiving.
  $execPaths = git -C $root ls-tree -r HEAD -- studio | Where-Object { $_ -match '^100755' } | ForEach-Object { ($_ -split "`t")[1] }
  foreach ($p in $execPaths) { git -C $root update-index --chmod=+x -- $p }
  $tree = (git -C $root write-tree).Trim()
} finally {
  Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue
  if (Test-Path $tmpIndex) { Remove-Item -Force $tmpIndex }
}

# core.autocrlf=false / core.eol=lf: the archive must be repository content (LF),
# otherwise a Windows worktree bakes CRLF into every file and git on the Linux
# server flags the whole tree as modified.
git -C $root -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz -o $tar $tree studio
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
Write-Host ('      {0} MB' -f [math]::Round((Get-Item $tar).Length / 1MB, 1)) -ForegroundColor DarkGray

Write-Host "[2/3] uploading to $Server" -ForegroundColor Cyan
scp -q $tar "${Server}:$remoteTar"
if ($LASTEXITCODE -ne 0) { throw 'scp of the archive failed' }
scp -q (Join-Path $root 'scripts/sync-apply.sh') "${Server}:$remoteScript"
if ($LASTEXITCODE -ne 0) { throw 'scp of sync-apply.sh failed' }

$flag = if ($Delete) { '--delete' } else { '' }
Write-Host "[3/3] applying on the server" -ForegroundColor Cyan
ssh $Server "sh $remoteScript $flag"
if ($LASTEXITCODE -ne 0) { throw 'remote sync failed' }

Write-Host 'done' -ForegroundColor Green
