param(
    [Parameter(Mandatory=$true)][string]$JdkPath,
    [Parameter(Mandatory=$true)][string]$BuildToolsPath,
    [Parameter(Mandatory=$true)][string]$AndroidJar,
    [Parameter(Mandatory=$true)][string]$WorkDir,
    [Parameter(Mandatory=$true)][string]$Keystore,
    [string]$KeyAlias = 'zeustimer',
    [string]$KeystorePassword = $env:ZEUS_KEYSTORE_PASSWORD,
    [string]$ApkPath = (Join-Path $PSScriptRoot '..\zeus-boss-timer.apk')
)
$ErrorActionPreference='Stop'
if([string]::IsNullOrEmpty($KeystorePassword)) { throw 'Set ZEUS_KEYSTORE_PASSWORD or pass -KeystorePassword. Keep the same key for all updates.' }
function Run-Checked([string]$Exe,[string[]]$Arguments) {
    & $Exe @Arguments
    if($LASTEXITCODE -ne 0) { throw "Command failed: $Exe (exit $LASTEXITCODE)" }
}
$buildDir = Join-Path ([IO.Path]::GetFullPath($WorkDir)) ('build-' + [Guid]::NewGuid().ToString('N'))
$generated = Join-Path $buildDir 'generated'
$classes = Join-Path $buildDir 'classes'
$testClasses = Join-Path $buildDir 'tests'
$dex = Join-Path $buildDir 'dex'
New-Item -ItemType Directory -Force -Path $buildDir,$generated,$classes,$testClasses,$dex | Out-Null
$env:TEMP=$buildDir
$env:TMP=$buildDir
$sourceRoot=Join-Path $PSScriptRoot 'app\src\main'
$java=Join-Path $JdkPath 'bin\java.exe'
$javac=Join-Path $JdkPath 'bin\javac.exe'
$jar=Join-Path $JdkPath 'bin\jar.exe'
$aapt=Join-Path $BuildToolsPath 'aapt.exe'
$unsigned=Join-Path $buildDir 'unsigned.apk'
& $aapt package -f -m -M (Join-Path $sourceRoot 'AndroidManifest.xml') -S (Join-Path $sourceRoot 'res') -I $AndroidJar -J $generated -F $unsigned --min-sdk-version 26 --target-sdk-version 35
if($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1073741819) { throw "AAPT failed: $LASTEXITCODE" }
if($LASTEXITCODE -eq -1073741819) { Write-Output 'AAPT ZIP-close crash: validating and rebuilding all archive entries with Node.js.' }
$javaFiles=@(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'java'),$generated -Recurse -Filter '*.java' | ForEach-Object {$_.FullName})
Run-Checked $javac (@('--release','8','-encoding','UTF-8','-classpath',$AndroidJar,'-d',$classes)+$javaFiles)
$engine=Join-Path $sourceRoot 'java\kr\local\zeustimer\Engine.java'
$catalog=Join-Path $sourceRoot 'java\kr\local\zeustimer\BossCatalog.java'
Run-Checked $javac @('--release','8','-encoding','UTF-8','-d',$testClasses,$engine,$catalog,(Join-Path $PSScriptRoot 'tests\EngineTest.java'),(Join-Path $PSScriptRoot 'tests\CatalogTest.java'))
Run-Checked $java @('-cp',$testClasses,'kr.local.zeustimer.EngineTest')
Run-Checked $java @('-cp',$testClasses,'kr.local.zeustimer.CatalogTest')
$classFiles=@(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object {$_.FullName})
Run-Checked $java (@("-Djava.io.tmpdir=$buildDir",'-cp',(Join-Path $BuildToolsPath 'lib\d8.jar'),'com.android.tools.r8.D8','--lib',$AndroidJar,'--min-api','26','--output',$dex)+$classFiles)
$aligned=Join-Path $buildDir 'aligned.apk'
Run-Checked 'node' @((Join-Path $PSScriptRoot 'tools\package-apk.cjs'),$unsigned,$aligned,(Join-Path $dex 'classes.dex'))
Run-Checked (Join-Path $BuildToolsPath 'zipalign.exe') @('-c','4',$aligned)
if(-not(Test-Path -LiteralPath $Keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Keystore) | Out-Null
    Run-Checked (Join-Path $JdkPath 'bin\keytool.exe') @('-genkeypair','-keystore',$Keystore,'-storepass',$KeystorePassword,'-keypass',$KeystorePassword,'-alias',$KeyAlias,'-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Zeus Boss Timer, O=Personal Distribution, C=KR')
}
$ApkPath=[IO.Path]::GetFullPath($ApkPath)
Run-Checked $java @('-jar',(Join-Path $BuildToolsPath 'lib\apksigner.jar'),'sign','--ks',$Keystore,'--ks-key-alias',$KeyAlias,'--ks-pass',"pass:$KeystorePassword",'--key-pass',"pass:$KeystorePassword",'--out',$ApkPath,$aligned)
Run-Checked $java @('-jar',(Join-Path $BuildToolsPath 'lib\apksigner.jar'),'verify','--verbose',$ApkPath)
Run-Checked (Join-Path $BuildToolsPath 'zipalign.exe') @('-c','4',$ApkPath)
Run-Checked $aapt @('dump','badging',$ApkPath)
Write-Output "APK ready: $ApkPath"
Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256
