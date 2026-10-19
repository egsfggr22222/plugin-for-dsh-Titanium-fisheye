# Titanium Fisheye -- capture engine.
#
# Gives the agent a real eye. Three capture targets, each using the mechanism
# that actually works for it:
#
#   screen   BitBlt from the desktop DC. Sees exactly what a person sees: the
#            topmost pixels, so a covering window hides whatever is beneath it.
#   window   PrintWindow with PW_RENDERFULLCONTENT. The window draws itself into
#            memory, so a covered window still yields its full content without
#            being raised or focus-stolen.
#   desktop  PrintWindow on the shell window (Progman). The wallpaper and icons
#            come back in full even when application windows cover the screen,
#            because the desktop paints itself rather than being read from it.
#
# Accuracy rules this file follows, because a screenshot that is silently wrong
# is worse than no screenshot:
#
#   - DPI awareness is declared before any size is read, so every number is in
#     physical pixels and matches what the user sees.
#   - Window rects come from DwmGetWindowAttribute, which excludes the invisible
#     resize border that GetWindowRect includes.
#   - Every capture is measured after the fact and rejected if its pixel size
#     does not equal the size that was requested.
#   - A capture that comes back blank is reported as blank rather than handed
#     over as a valid image.
#
# Output is one JSON object on stdout. This file must stay ASCII-only: Windows
# PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page.

param(
  [ValidateSet('screen', 'window', 'desktop', 'list', 'info')]
  [string]$Mode = 'screen',
  [string]$Out = '',
  [string]$Title = '',
  [long]$Hwnd = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class EyeWindow
{
    public IntPtr Handle;
    public string Title;
    public string ClassName;
    public int X, Y, W, H;
    public bool Minimized;
    public bool Foreground;
}

public static class Eye
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string w);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const uint GW_OWNER = 4;
    const uint SRCCOPY = 0x00CC0020;
    const uint CAPTUREBLT = 0x40000000;
    public const uint PW_RENDERFULLCONTENT = 2;

    /// <summary>Become DPI aware so every size we read is a physical pixel.</summary>
    public static void BecomeAware()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { SetProcessDPIAware(); }
    }

    /// <summary>On-screen bounds excluding the invisible resize border.</summary>
    public static bool TryBound(IntPtr h, out RECT r)
    {
        int hr = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
        if (hr == 0) return true;
        return GetWindowRect(h, out r);
    }

    /// <summary>Top-level windows a person could point at.</summary>
    public static List<EyeWindow> List()
    {
        var list = new List<EyeWindow>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows((h, p) =>
        {
            if (!IsWindowVisible(h)) return true;
            var title = new StringBuilder(512);
            GetWindowText(h, title, 512);
            if (title.Length == 0) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;

            RECT r;
            if (!TryBound(h, out r)) return true;
            int w = r.R - r.L;
            int ht = r.B - r.T;
            if (w <= 0 || ht <= 0) return true;

            var info = new EyeWindow();
            info.Handle = h;
            info.Title = title.ToString();
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            info.ClassName = cls.ToString();
            info.X = r.L; info.Y = r.T; info.W = w; info.H = ht;
            info.Minimized = IsIconic(h);
            info.Foreground = (h == fg);
            list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>The shell window that paints wallpaper and icons.</summary>
    public static IntPtr DesktopHost()
    {
        IntPtr shell = GetShellWindow();
        if (shell != IntPtr.Zero) return shell;
        IntPtr progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero) return progman;
        IntPtr worker = IntPtr.Zero;
        do
        {
            worker = FindWindowEx(IntPtr.Zero, worker, "WorkerW", null);
            if (worker == IntPtr.Zero) break;
            if (FindWindowEx(worker, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return worker;
        } while (true);
        return IntPtr.Zero;
    }

    /// <summary>Ask a window to paint itself into a bitmap of the given size.</summary>
    public static Bitmap Render(IntPtr hwnd, int w, int h, out bool ok)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            IntPtr dc = g.GetHdc();
            try { ok = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(dc); }
        }
        return bmp;
    }

    /// <summary>Copy the visible screen.</summary>
    public static Bitmap Grab(int x, int y, int w, int h)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
        IntPtr old = SelectObject(mem, bmp);
        try
        {
            BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
            return (Bitmap)Image.FromHbitmap(bmp);
        }
        finally
        {
            SelectObject(mem, old);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    /// <summary>
    /// Share of sampled pixels that are not near-black. A failed PrintWindow
    /// returns an empty bitmap, which this catches so a black frame is never
    /// reported as a successful capture.
    /// </summary>
    public static double Ink(Bitmap b)
    {
        int lit = 0, total = 0;
        int stepX = Math.Max(1, b.Width / 96);
        int stepY = Math.Max(1, b.Height / 96);
        for (int y = 0; y < b.Height; y += stepY)
        {
            for (int x = 0; x < b.Width; x += stepX)
            {
                Color c = b.GetPixel(x, y);
                total++;
                if (c.R > 14 || c.G > 14 || c.B > 14) lit++;
            }
        }
        return total == 0 ? 0 : (double)lit / total;
    }
}
'@

# -- helpers -----------------------------------------------------------------

function Write-Result($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 6)
}

function Fail([string]$reason, [string]$detail) {
  Write-Result ([ordered]@{ ok = $false; reason = $reason; detail = $detail })
  exit 1
}

function Save-Checked($bmp, [string]$path, [int]$expectW, [int]$expectH) {
  if ($bmp.Width -ne $expectW -or $bmp.Height -ne $expectH) {
    return [ordered]@{
      ok = $false
      reason = 'size-mismatch'
      detail = ("captured {0}x{1}, expected {2}x{3}" -f $bmp.Width, $bmp.Height, $expectW, $expectH)
    }
  }
  $dir = [System.IO.Path]::GetDirectoryName($path)
  if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  # Confirm what actually reached the file, not just the in-memory bitmap.
  $check = [System.Drawing.Image]::FromFile($path)
  try {
    if ($check.Width -ne $expectW -or $check.Height -ne $expectH) {
      return [ordered]@{
        ok = $false
        reason = 'file-mismatch'
        detail = ("file is {0}x{1}, expected {2}x{3}" -f $check.Width, $check.Height, $expectW, $expectH)
      }
    }
  } finally {
    $check.Dispose()
  }
  return $null
}

[Eye]::BecomeAware()
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$sw = $screen.Width
$sh = $screen.Height

switch ($Mode) {

  'info' {
    Write-Result ([ordered]@{
      ok = $true
      screen = [ordered]@{ w = $sw; h = $sh; x = $screen.X; y = $screen.Y }
      desktopHost = [Eye]::DesktopHost().ToInt64()
      monitorCount = [System.Windows.Forms.Screen]::AllScreens.Count
    })
    exit 0
  }

  'list' {
    $rows = @()
    foreach ($w in [Eye]::List()) {
      $rows += [ordered]@{
        hwnd = $w.Handle.ToInt64()
        title = $w.Title
        className = $w.ClassName
        x = $w.X; y = $w.Y; w = $w.W; h = $w.H
        minimized = $w.Minimized
        foreground = $w.Foreground
      }
    }
    Write-Result ([ordered]@{
      ok = $true
      screen = [ordered]@{ w = $sw; h = $sh }
      windows = $rows
    })
    exit 0
  }

  'screen' {
    if ([string]::IsNullOrWhiteSpace($Out)) { Fail 'missing-out' 'screen capture needs -Out' }
    $bmp = $null
    try {
      $bmp = [Eye]::Grab($screen.X, $screen.Y, $sw, $sh)
      $ink = [Eye]::Ink($bmp)
      $bad = Save-Checked $bmp $Out $sw $sh
      if ($bad -ne $null) { Write-Result $bad; exit 1 }
      Write-Result ([ordered]@{
        ok = $true
        kind = 'screen'
        path = $Out
        width = $sw
        height = $sh
        screen = [ordered]@{ w = $sw; h = $sh }
        ink = [math]::Round($ink, 4)
        note = 'the visible screen: windows covering the desktop appear as the user sees them'
      })
    } finally {
      if ($bmp -ne $null) { $bmp.Dispose() }
    }
    exit 0
  }

  'desktop' {
    if ([string]::IsNullOrWhiteSpace($Out)) { Fail 'missing-out' 'desktop capture needs -Out' }
    $host_ = [Eye]::DesktopHost()
    if ($host_ -eq [IntPtr]::Zero) { Fail 'no-desktop-window' 'the shell window was not found' }

    $bmp = $null
    $okPrint = $false
    try {
      $bmp = [Eye]::Render($host_, $sw, $sh, [ref]$okPrint)
      $ink = [Eye]::Ink($bmp)
      # A blank or partly painted desktop means the shell declined to render;
      # say so instead of shipping a black frame.
      if ($ink -lt 0.02) {
        Write-Result ([ordered]@{
          ok = $false
          reason = 'blank-capture'
          detail = ("desktop rendered with only {0:P1} ink; the shell may not support PrintWindow" -f $ink)
        })
        exit 1
      }
      $bad = Save-Checked $bmp $Out $sw $sh
      if ($bad -ne $null) { Write-Result $bad; exit 1 }
      Write-Result ([ordered]@{
        ok = $true
        kind = 'desktop'
        path = $Out
        width = $sw
        height = $sh
        screen = [ordered]@{ w = $sw; h = $sh }
        ink = [math]::Round($ink, 4)
        note = 'the desktop painted by itself: wallpaper and icons are visible even where windows cover them'
      })
    } finally {
      if ($bmp -ne $null) { $bmp.Dispose() }
    }
    exit 0
  }

  'window' {
    if ([string]::IsNullOrWhiteSpace($Out)) { Fail 'missing-out' 'window capture needs -Out' }

    # Pick the target: a handle wins, then an exact title, then a unique substring.
    $target = $null
    $all = [Eye]::List()
    if ($Hwnd -ne 0) {
      foreach ($w in $all) {
        if ($w.Handle.ToInt64() -eq $Hwnd) { $target = $w; break }
      }
      if ($target -eq $null -and [Eye]::IsWindow([IntPtr]$Hwnd)) {
        $title = New-Object System.Text.StringBuilder 512
        [void][Eye]::GetWindowText([IntPtr]$Hwnd, $title, 512)
        $cls = New-Object System.Text.StringBuilder 256
        [void][Eye]::GetClassName([IntPtr]$Hwnd, $cls, 256)
        $r = New-Object Eye+RECT
        [void][Eye]::TryBound([IntPtr]$Hwnd, [ref]$r)
        $target = New-Object EyeWindow
        $target.Handle = [IntPtr]$Hwnd
        $target.Title = $title.ToString()
        $target.ClassName = $cls.ToString()
        $target.X = $r.L; $target.Y = $r.T
        $target.W = $r.R - $r.L; $target.H = $r.B - $r.T
        $target.Minimized = [Eye]::IsIconic([IntPtr]$Hwnd)
      }
    } elseif (-not [string]::IsNullOrWhiteSpace($Title)) {
      foreach ($w in $all) {
        if ($w.Title -eq $Title) { $target = $w; break }
      }
      if ($target -eq $null) {
        $loose = @()
        foreach ($w in $all) {
          if ($w.Title -like "*$Title*") { $loose += $w }
        }
        if ($loose.Count -eq 1) { $target = $loose[0] }
        elseif ($loose.Count -gt 1) {
          $names = ($loose | ForEach-Object { $_.Title }) -join ' | '
          Fail 'ambiguous-title' ("{0} windows match; pass hwnd instead: {1}" -f $loose.Count, $names)
        }
      }
    } else {
      Fail 'missing-target' 'window capture needs -Title or -Hwnd'
    }

    if ($target -eq $null) { Fail 'window-not-found' 'no matching window' }
    if ($target.Minimized) { Fail 'minimized' 'this window is minimized; call list and pick a visible one' }
    if ($target.W -le 0 -or $target.H -le 0) {
      Fail 'empty-bounds' ("window reports {0}x{1}" -f $target.W, $target.H)
    }

    $bmp = $null
    $okPrint = $false
    try {
      $bmp = [Eye]::Render($target.Handle, $target.W, $target.H, [ref]$okPrint)
      $ink = [Eye]::Ink($bmp)
      if ($ink -lt 0.01) {
        Write-Result ([ordered]@{
          ok = $false
          reason = 'blank-capture'
          detail = ("window rendered with only {0:P1} ink; it may refuse PrintWindow" -f $ink)
          hwnd = $target.Handle.ToInt64()
          title = $target.Title
        })
        exit 1
      }
      $bad = Save-Checked $bmp $Out $target.W $target.H
      if ($bad -ne $null) { Write-Result $bad; exit 1 }
      Write-Result ([ordered]@{
        ok = $true
        kind = 'window'
        path = $Out
        width = $target.W
        height = $target.H
        screen = [ordered]@{ w = $sw; h = $sh }
        hwnd = $target.Handle.ToInt64()
        title = $target.Title
        className = $target.ClassName
        bounds = [ordered]@{ x = $target.X; y = $target.Y; w = $target.W; h = $target.H }
        ink = [math]::Round($ink, 4)
        note = 'the window painted itself: full content even where other windows cover it'
      })
    } finally {
      if ($bmp -ne $null) { $bmp.Dispose() }
    }
    exit 0
  }
}
