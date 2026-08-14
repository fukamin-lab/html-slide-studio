param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [int]$TimeoutMs = 60000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient

function ConvertFrom-HexCharacters {
  param([string]$HexCharacters)
  return -join ($HexCharacters.Split("-") | ForEach-Object { [char][Convert]::ToInt32($_, 16) })
}

$demoButtonName = ConvertFrom-HexCharacters "30c7-30e2-3092-958b-304f"
$textButtonName = ConvertFrom-HexCharacters "30c6-30ad-30b9-30c8"
$dirtyStatusName = ConvertFrom-HexCharacters "672a-4fdd-5b58-306e-5909-66f4"

function Get-DescendantProcessIds {
  param([int]$ParentId)

  $known = [System.Collections.Generic.HashSet[int]]::new()
  [void]$known.Add($ParentId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in Get-CimInstance Win32_Process) {
      $processId = [int]$process.ProcessId
      $parentProcessId = [int]$process.ParentProcessId
      if ($known.Contains($parentProcessId) -and $known.Add($processId)) {
        $changed = $true
      }
    }
  }
  return ,$known
}

function Find-OwnedMainWindow {
  param([System.Collections.Generic.HashSet[int]]$AllowedProcessIds)

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($window in $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )) {
    if ($AllowedProcessIds.Contains([int]$window.Current.ProcessId) -and $window.Current.Name -eq "HTML Slide Studio") {
      return $window
    }
  }
  return $null
}

function Find-DescendantButton {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$Name
  )

  $condition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    ),
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $Name
    )
  )
  return $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-DescendantNames {
  param([System.Windows.Automation.AutomationElement]$Window)

  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($element in $Window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )) {
    $name = $element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $names.Add($name)
    }
  }
  return $names
}

function Invoke-Button {
  param([System.Windows.Automation.AutomationElement]$Button)

  $pattern = $Button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$mainWindow = $null
$demoButton = $null
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $demoButton) {
  try {
    $allowed = Get-DescendantProcessIds -ParentId $RootProcessId
    $mainWindow = Find-OwnedMainWindow -AllowedProcessIds $allowed
    if ($null -ne $mainWindow) {
      $demoButton = Find-DescendantButton -Window $mainWindow -Name $demoButtonName
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    $mainWindow = $null
  }
  if ($null -eq $demoButton) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $demoButton) {
  throw "Packaged Welcome screen did not expose the demo action through Windows accessibility."
}
Invoke-Button -Button $demoButton

$expectedSlideLabels = @(
  (ConvertFrom-HexCharacters "3088-3046-3053-305d"),
  (ConvertFrom-HexCharacters "6587-5b57-3092-76f4-3059"),
  (ConvertFrom-HexCharacters "30b9-30e9-30a4-30c9-3092-5897-3084-3059"),
  (ConvertFrom-HexCharacters "898b-305f-76ee-3092-6574-3048-308b"),
  (ConvertFrom-HexCharacters "6587-5b57-3068-753b-50cf-3092-8ffd-52a0-3059-308b"),
  (ConvertFrom-HexCharacters "767a-8868-8005-30ce-30fc-30c8-3092-66f8-304f"),
  (ConvertFrom-HexCharacters "767a-8868-3059-308b"),
  (ConvertFrom-HexCharacters "4fdd-5b58-3057-3066-958b-304d-76f4-3059")
)
$textButton = $null
$observedNames = @()
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $allowed = Get-DescendantProcessIds -ParentId $RootProcessId
    $mainWindow = Find-OwnedMainWindow -AllowedProcessIds $allowed
    if ($null -ne $mainWindow) {
      $textButton = Find-DescendantButton -Window $mainWindow -Name $textButtonName
      $observedNames = @(Get-DescendantNames -Window $mainWindow)
      $hasDocumentName = $observedNames | Where-Object { $_ -like "*html-slide-studio-demo.html*" }
      $observedSlideLabels = @($expectedSlideLabels | Where-Object {
        $label = $_
        [bool]($observedNames | Where-Object { $_ -like "*$label*" } | Select-Object -First 1)
      })
      if ($null -ne $textButton -and $hasDocumentName -and $observedSlideLabels.Count -eq $expectedSlideLabels.Count) {
        break
      }
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    $textButton = $null
  }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $textButton) {
  throw "Packaged demo did not reach the editor toolbar through Windows accessibility."
}
if (-not ($observedNames | Where-Object { $_ -like "*html-slide-studio-demo.html*" })) {
  throw "Packaged demo document name was not exposed through Windows accessibility."
}
foreach ($label in $expectedSlideLabels) {
  if (-not ($observedNames | Where-Object { $_ -like "*$label*" })) {
    throw "Packaged demo slide was not exposed through Windows accessibility: $label"
  }
}

Invoke-Button -Button $textButton
$dirtyObserved = $false
while ([DateTime]::UtcNow -lt $deadline -and -not $dirtyObserved) {
  try {
    $observedNames = @(Get-DescendantNames -Window $mainWindow)
    $dirtyObserved = [bool]($observedNames | Where-Object { $_ -like "*$dirtyStatusName*" })
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    $dirtyObserved = $false
  }
  if (-not $dirtyObserved) { Start-Sleep -Milliseconds 100 }
}
if (-not $dirtyObserved) {
  throw "Packaged text insertion did not expose the unsaved state through Windows accessibility."
}

[ordered]@{
  pass = $true
  mainProcessId = [int]$mainWindow.Current.ProcessId
  packagedDemoOpenedFromWelcome = $true
  documentName = "html-slide-studio-demo.html"
  slideCount = $expectedSlideLabels.Count
  dirtyTextAdded = $true
} | ConvertTo-Json -Compress
