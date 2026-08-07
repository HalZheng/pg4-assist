[CmdletBinding()]
param(
    [string]$DatabaseName = "moe_r4_r5_20260416",
    [string]$HostName = "10.1.53.102",
    [int]$Port = 5432,
    [string]$UserName = "moedbuser1",
    [string]$OutputDirectory = "C:\Users\Rhys.du\Downloads",
    [string]$PostgresBinDirectory = "C:\Program Files\PostgreSQL\18\bin"
)

$ErrorActionPreference = "Stop"

$pgDump = Join-Path $PostgresBinDirectory "pg_dump.exe"
$psql = Join-Path $PostgresBinDirectory "psql.exe"
foreach ($tool in @($pgDump, $psql)) {
    if (-not (Test-Path $tool)) {
        throw "PostgreSQL tool was not found: $tool"
    }
}

if (-not (Test-Path $OutputDirectory)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}

$datePattern = "(19|20)[0-9]{6}|(19|20)[0-9]{4}"
$exclusionQuery = @"
WITH RECURSIVE matching_roots AS (
    SELECT
        relation.oid,
        namespace.nspname AS schema_name,
        relation.relname AS relation_name
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p')
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_toast'
      AND relation.relname ~ '$datePattern'
),
relations_to_exclude AS (
    SELECT oid, schema_name, relation_name
    FROM matching_roots

    UNION

    SELECT
        child_relation.oid,
        child_namespace.nspname AS schema_name,
        child_relation.relname AS relation_name
    FROM relations_to_exclude AS parent_relation
    INNER JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = parent_relation.oid
    INNER JOIN pg_catalog.pg_class AS child_relation
        ON child_relation.oid = inheritance.inhrelid
    INNER JOIN pg_catalog.pg_namespace AS child_namespace
        ON child_namespace.oid = child_relation.relnamespace
)
SELECT DISTINCT
    schema_name,
    relation_name
FROM relations_to_exclude
ORDER BY
    schema_name,
    relation_name;
"@

$psqlArguments = @(
    "--host", $HostName,
    "--port", $Port,
    "--username", $UserName,
    "--dbname", $DatabaseName,
    "--tuples-only",
    "--no-align",
    "--field-separator", "|",
    "--command", $exclusionQuery
)

Write-Host "Finding date-named tables and partition descendants..."
$excludedRows = & $psql @psqlArguments
if ($LASTEXITCODE -ne 0) {
    throw "Unable to query the PostgreSQL catalog for date-named tables."
}

$excludedRelations = @(
    $excludedRows |
        Where-Object { $_ -and $_.Trim() } |
        ForEach-Object {
            $parts = $_ -split "\|", 2
            if ($parts.Count -ne 2) {
                throw "Unexpected catalog output: $_"
            }
            [pscustomobject]@{
                Schema = $parts[0]
                Name = $parts[1]
            }
        }
)

function Quote-PgIdentifier([string]$Identifier) {
    return '"' + $Identifier.Replace('"', '""') + '"'
}

$outputDate = Get-Date -Format "yyyyMMdd"
$outputPath = Join-Path $OutputDirectory "$DatabaseName-$outputDate-snapshots.sql"
$pgDumpArguments = @(
    "--host", $HostName,
    "--port", $Port,
    "--username", $UserName,
    "--dbname", $DatabaseName,
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--file", $outputPath
)

foreach ($relation in $excludedRelations) {
    $pgDumpArguments += "--exclude-table"
    $pgDumpArguments += "$(Quote-PgIdentifier $relation.Schema).$(Quote-PgIdentifier $relation.Name)"
}

Write-Host "Exporting schema-only snapshot to $outputPath"
& $pgDump @pgDumpArguments
if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed. No successful snapshot was produced."
}

if (-not (Test-Path $outputPath) -or (Get-Item $outputPath).Length -eq 0) {
    throw "Snapshot output is missing or empty: $outputPath"
}

$snapshotText = Get-Content -Path $outputPath -Raw
$remainingExcludedDefinitions = @(
    foreach ($relation in $excludedRelations) {
        $qualifiedName = "$(Quote-PgIdentifier $relation.Schema).$(Quote-PgIdentifier $relation.Name)"
        if ($snapshotText.Contains($qualifiedName, [StringComparison]::Ordinal)) {
            $qualifiedName
        }
    }
)
if ($remainingExcludedDefinitions.Count -gt 0) {
    throw "Excluded relation definitions remain in the snapshot: $($remainingExcludedDefinitions -join ', ')"
}

$summaryQuery = @"
SELECT
    (
        SELECT count(*)
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
          AND namespace.nspname !~ '^pg_toast'
    ) AS user_schema_count,
    (
        SELECT count(*)
        FROM pg_catalog.pg_class AS relation
        INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
          AND namespace.nspname !~ '^pg_toast'
    ) AS relation_count,
    (
        SELECT count(*)
        FROM pg_catalog.pg_proc AS routine
        INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
          AND namespace.nspname !~ '^pg_toast'
    ) AS function_count;
"@
$summaryRows = & $psql @($psqlArguments[0..9] + @("--field-separator", "|", "--command", $summaryQuery))
if ($LASTEXITCODE -ne 0) {
    throw "Snapshot completed, but the database summary query failed."
}

Write-Host "Snapshot created: $outputPath"
Write-Host "Excluded date-named relations: $($excludedRelations.Count)"
if ($excludedRelations.Count -gt 0) {
    $excludedRelations | ForEach-Object { Write-Host "  - $($_.Schema).$($_.Name)" }
}
Write-Host "Database summary (all user objects before exclusion): $($summaryRows -join ' ')"
Write-Host "Validation passed: output exists, is non-empty, and contains no excluded relation definitions."