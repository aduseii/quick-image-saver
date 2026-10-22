# Quick Image Saver - updater helper.
#
# The extension starts this (through host.bat) only when it finds a newer
# version on GitHub. It downloads that version and installs it into the
# extension's folder; the extension then restarts itself.
#
# Chrome talks to it with "native messaging": a 4-byte length, then JSON,
# over stdin/stdout. Nothing else may be written to stdout.
#
# Written for Windows PowerShell 5.1 (built into Windows) and PowerShell 7.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo    = 'aduseii/quick-image-saver'
$Branch  = 'main'
$AppName = 'Quick Image Saver'
$ZipUrl  = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
if ($env:QIS_UPDATE_ZIP_URL) { $ZipUrl = $env:QIS_UPDATE_ZIP_URL } # used by tests
$ExtDir  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ListFile = Join-Path $ExtDir '.qis-files'

function Read-Message {
    $in = [Console]::OpenStandardInput()
    $head = New-Object byte[] 4
    $got = 0
    while ($got -lt 4) {
        $n = $in.Read($head, $got, 4 - $got)
        if ($n -le 0) { return $null }
        $got += $n
    }
    $len = [BitConverter]::ToInt32($head, 0)
    if ($len -le 0 -or $len -gt 1048576) { return $null }
    $buf = New-Object byte[] $len
    $got = 0
    while ($got -lt $len) {
        $n = $in.Read($buf, $got, $len - $got)
        if ($n -le 0) { break }
        $got += $n
    }
    return ([Text.Encoding]::UTF8.GetString($buf, 0, $got) | ConvertFrom-Json)
}

function Send-Message($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $out = [Console]::OpenStandardOutput()
    $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

function Read-Manifest($path) {
    return (Get-Content -Raw -Encoding UTF8 -Path $path | ConvertFrom-Json)
}

function Get-RelativeFiles($root) {
    $root = $root.TrimEnd('\', '/')
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        if ($rel -like '.git/*') { continue }
        $list.Add($rel)
    }
    return $list
}

# Copy the new version over the old one. Only files that belonged to an
# earlier version (listed in .qis-files) are ever deleted - never anything else.
function Sync-Folder($from, $to) {
    $newFiles = Get-RelativeFiles $from
    $keep = @{}
    foreach ($rel in $newFiles) {
        $keep[$rel] = $true
        $src = Join-Path $from $rel
        $dest = Join-Path $to $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
        $same = (Test-Path -LiteralPath $dest) -and ((Get-FileHash -LiteralPath $dest).Hash -eq (Get-FileHash -LiteralPath $src).Hash)
        if (-not $same) { Copy-Item -LiteralPath $src -Destination $dest -Force }
    }
    if (Test-Path -LiteralPath $ListFile) {
        foreach ($rel in (Get-Content -LiteralPath $ListFile -Encoding UTF8)) {
            $rel = $rel.Trim()
            if (-not $rel -or $keep.ContainsKey($rel) -or $rel.Contains('..')) { continue }
            $old = Join-Path $to $rel
            if (Test-Path -LiteralPath $old -PathType Leaf) { Remove-Item -LiteralPath $old -Force }
            $dir = Split-Path -Parent $old
            while ($dir -and ($dir.Length -gt $to.Length) -and (Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) {
                Remove-Item -LiteralPath $dir -Force
                $dir = Split-Path -Parent $dir
            }
        }
    }
    [IO.File]::WriteAllLines($ListFile, [string[]]$newFiles, (New-Object Text.UTF8Encoding $false))
}

function Install-Update($expect) {
    $current = Join-Path $ExtDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $current) -or (Read-Manifest $current).name -ne $AppName) {
        throw "The updater is not inside the $AppName folder"
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('qis-update-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $zip = Join-Path $tmp 'update.zip'
        Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
        $unzipped = Join-Path $tmp 'files'
        Expand-Archive -LiteralPath $zip -DestinationPath $unzipped -Force
        $mf = Get-ChildItem -LiteralPath $unzipped -Filter 'manifest.json' -Recurse -File |
            Sort-Object { $_.FullName.Length } | Select-Object -First 1
        if (-not $mf) { throw 'The download has no manifest.json' }
        $m = Read-Manifest $mf.FullName
        if ($m.name -ne $AppName) { throw "The download is not $AppName" }
        if ($expect -and ($m.version -ne $expect)) { throw "Expected version $expect but GitHub has $($m.version)" }
        Sync-Folder $mf.DirectoryName $ExtDir
        return $m.version
    }
    finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    $msg = Read-Message
    if ($null -eq $msg) { exit 0 }
    if ($msg.type -eq 'ping') {
        Send-Message @{ ok = $true; version = (Read-Manifest (Join-Path $ExtDir 'manifest.json')).version; folder = $ExtDir }
    }
    elseif ($msg.type -eq 'update') {
        $v = Install-Update $msg.expect
        Send-Message @{ ok = $true; version = $v }
    }
    else {
        Send-Message @{ ok = $false; error = 'Unknown request' }
    }
}
catch {
    Send-Message @{ ok = $false; error = $_.Exception.Message }
}
