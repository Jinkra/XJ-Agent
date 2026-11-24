$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskExe = Join-Path $taskRoot 'dist\小金同学-win32-x64\Jinkra.exe'
if (Test-Path -LiteralPath $taskExe) {
  Start-Process -FilePath $taskExe -WindowStyle Hidden
} else {
  $taskElectron = Join-Path $taskRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $taskElectron)) { throw '请先在项目目录运行 npm install，或使用打包后的 Jinkra.exe。' }
  Start-Process -FilePath $taskElectron -ArgumentList ('"' + $taskRoot + '"') -WindowStyle Hidden
}
