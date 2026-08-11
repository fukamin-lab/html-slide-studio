param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [ValidateSet("Discard", "Cancel")]
  [string]$Action = "Discard",

  [int]$TimeoutMs = 20000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeWindowClose {
  private const uint BmClick = 0x00F5;

  private delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  private static string ReadWindowText(IntPtr hWnd) {
    var value = new StringBuilder(1024);
    GetWindowText(hWnd, value, value.Capacity);
    return value.ToString();
  }

  private static string ReadClassName(IntPtr hWnd) {
    var value = new StringBuilder(256);
    GetClassName(hWnd, value, value.Capacity);
    return value.ToString();
  }

  private static string NormalizeButtonText(string value) {
    return (value ?? string.Empty).Replace("&", string.Empty).Trim();
  }

  public static int ClickOwnedButton(int[] processIds, string expectedText) {
    var allowed = new HashSet<uint>();
    foreach (var processId in processIds) allowed.Add((uint)processId);
    var clickedProcessId = 0;
    EnumWindows(delegate(IntPtr topLevel, IntPtr _) {
      uint processId;
      GetWindowThreadProcessId(topLevel, out processId);
      if (!allowed.Contains(processId) || !IsWindowVisible(topLevel)) return true;
      EnumChildWindows(topLevel, delegate(IntPtr child, IntPtr __) {
        if (!string.Equals(ReadClassName(child), "Button", StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.Equals(NormalizeButtonText(ReadWindowText(child)), NormalizeButtonText(expectedText), StringComparison.Ordinal)) return true;
        SendMessage(child, BmClick, IntPtr.Zero, IntPtr.Zero);
        clickedProcessId = (int)processId;
        return false;
      }, IntPtr.Zero);
      return clickedProcessId == 0;
    }, IntPtr.Zero);
    return clickedProcessId;
  }

  public static string DumpOwnedWindows(int[] processIds) {
    var allowed = new HashSet<uint>();
    foreach (var processId in processIds) allowed.Add((uint)processId);
    var windows = new List<string>();
    EnumWindows(delegate(IntPtr topLevel, IntPtr _) {
      uint processId;
      GetWindowThreadProcessId(topLevel, out processId);
      if (!allowed.Contains(processId) || !IsWindowVisible(topLevel)) return true;
      var controls = new List<string>();
      EnumChildWindows(topLevel, delegate(IntPtr child, IntPtr __) {
        var text = ReadWindowText(child);
        var className = ReadClassName(child);
        if (!string.IsNullOrWhiteSpace(text) || string.Equals(className, "Button", StringComparison.OrdinalIgnoreCase)) {
          controls.Add(className + ":" + text);
        }
        return true;
      }, IntPtr.Zero);
      windows.Add("pid=" + processId + " class=" + ReadClassName(topLevel) + " name=" + ReadWindowText(topLevel) + " controls=" + string.Join(",", controls));
      return true;
    }, IntPtr.Zero);
    return string.Join("; ", windows);
  }
}
"@

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

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$buttonName = if ($Action -eq "Discard") {
  [string]::Concat(
    [char]0x4FDD,
    [char]0x5B58,
    [char]0x305B,
    [char]0x305A,
    [char]0x7D42,
    [char]0x4E86
  )
} else {
  [string]::Concat(
    [char]0x30AD,
    [char]0x30E3,
    [char]0x30F3,
    [char]0x30BB,
    [char]0x30EB
  )
}
$allowedProcessIds = Get-DescendantProcessIds -ParentId $RootProcessId
$root = [System.Windows.Automation.AutomationElement]::RootElement
$topLevelScope = [System.Windows.Automation.TreeScope]::Children
$descendantScope = [System.Windows.Automation.TreeScope]::Descendants
$buttonCondition = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  ),
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $buttonName
  )
)
$ownedMainWindow = $null
foreach ($window in $root.FindAll($topLevelScope, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($allowedProcessIds.Contains([int]$window.Current.ProcessId) -and $window.Current.Name -eq "HTML Slide Studio") {
    $ownedMainWindow = $window
    break
  }
}

if ($null -eq $ownedMainWindow) {
  Write-Error "Could not find the owned HTML Slide Studio window."
  exit 1
}

$mainProcessId = [int]$ownedMainWindow.Current.ProcessId
$nativeHandle = [IntPtr]$ownedMainWindow.Current.NativeWindowHandle
if ($nativeHandle -eq [IntPtr]::Zero -or -not [NativeWindowClose]::PostMessage($nativeHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
  Write-Error "Could not post WM_CLOSE to the owned HTML Slide Studio window."
  exit 1
}
Write-Output "close-requested:$mainProcessId"

while ([DateTime]::UtcNow -lt $deadline) {
  $allowedProcessIds = Get-DescendantProcessIds -ParentId $RootProcessId
  $allowedProcessIdArray = @($allowedProcessIds | ForEach-Object { [int]$_ })
  $nativeButtonProcessId = [NativeWindowClose]::ClickOwnedButton($allowedProcessIdArray, $buttonName)
  if ($nativeButtonProcessId -ne 0) {
    Write-Output "confirmed:${Action}:$nativeButtonProcessId"
    exit 0
  }

  $buttons = $root.FindAll($descendantScope, $buttonCondition)
  foreach ($button in $buttons) {
    if (-not $allowedProcessIds.Contains([int]$button.Current.ProcessId)) {
      continue
    }

    $ownedProcessId = [int]$button.Current.ProcessId
    $invokePattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
    Write-Output "confirmed:${Action}:$ownedProcessId"
    exit 0
  }

  Start-Sleep -Milliseconds 100
}

$allowedProcessIdArray = @($allowedProcessIds | ForEach-Object { [int]$_ })
$nativeWindows = [NativeWindowClose]::DumpOwnedWindows($allowedProcessIdArray)
$ownedWindows = @()
foreach ($window in $root.FindAll($topLevelScope, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($allowedProcessIds.Contains([int]$window.Current.ProcessId)) {
    $buttonNames = @()
    $buttonElements = $window.FindAll(
      $descendantScope,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
    foreach ($buttonElement in $buttonElements) {
      $buttonNames += $buttonElement.Current.Name
    }
    $ownedWindows += "pid=$($window.Current.ProcessId) name=$($window.Current.Name) buttons=$($buttonNames -join ',')"
  }
}
Write-Error "Timed out waiting for the owned '$buttonName' dialog button. Native windows: $nativeWindows. UIA windows: $($ownedWindows -join '; ')"
exit 1
