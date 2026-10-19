[中文readme](https://github.com/egsfggr22222/plugin-for-dsh-Titanium-fisheye/blob/main/%E9%92%9B%E5%90%88%E9%87%91%E9%B1%BC%E7%9C%BC/README.md)

---

# Titanium Fisheye

Give the agent a **pair of real eyes**.

By default, an agent is nearsighted: its shell process doesn't declare DPI awareness, so the system tells it that a 1920×1080 screen is 1536×864. It draws and measures according to that number, so everything ends up off by a factor of 0.8, **and no error is ever raised**.

This plugin bypasses that broken path: every screenshot path first declares DPI awareness, so dimensions are always in physical pixels.

## Three kinds of screenshots

| Target | What you see | How it works |
|---|---|---|
| `screen` | What a human sees | `BitBlt` captures the desktop DC. Desktop areas covered by windows look covered |
| `desktop` | **Wallpaper + icons, visible even when occluded** | `PrintWindow` makes the desktop window draw itself into memory |
| `window` | **The full content of a window, visible even when occluded** | `PrintWindow` makes that window draw itself; no need to bring it to the front or focus it |

Minimized windows are not captured: they have no content to draw, and restoring them would disrupt the user's screen.

## Tools

```
eye { action: "screen" }                    Full-screen screenshot
eye { action: "desktop" }                   Desktop screenshot (including occluded parts)
eye { action: "window", title: "Notepad" }  Capture a window by title
eye { action: "window", hwnd: 123456 }      Capture by handle (when titles are duplicated)
eye { action: "list" }                      List all visible windows + exact bounds
eye { action: "info" }                      Real screen dimensions
```

Every return includes:

```json
{
  "ok": true,
  "kind": "window",
  "width": 1920,
  "height": 1030,
  "screen": { "w": 1920, "h": 1080 },
  "ink": 0.98,
  "image": "data:image/png;base64,..."
}
```

- `width` / `height` are the **real pixel dimensions of this image**
- `screen` is the **real desktop size**, so the two can be compared
- `ink` is the proportion of effective content; too low means a black image was captured

## Why validation is mandatory

The most common problem with screenshots is **silent error**: the image looks fine, but the dimensions are wrong. Therefore:

1. Immediately measure your own output after capture; if the dimensions don't match, raise an error
2. After saving to disk, measure the file again to confirm the complete image was written
3. If `ink` is below the threshold, treat it as a black image and do not count it as success

Better to return a failure than to hand over a wrong image.

## Known boundaries

| Situation | Result |
|---|---|
| Desktop occluded by windows | ✅ `desktop` can capture it |
| Window occluded by other windows | ✅ `window` can capture it |
| Window minimized | ❌ Explicitly reports `minimized` |
| Hardware-accelerated windows (some games) | ⚠️ `PrintWindow` may return a black image; caught by `ink` |

## Structure

| File | Purpose |
|---|---|
| `index.js` | Host: `eye` tool, routing, result cache |
| `client.js` | Browser: settings page (screen dimensions, window list, recent screenshots) |
| `capture.ps1` | Capture engine, pure ASCII |

## Settings page

Settings → "Titanium Fisheye" on the left:

- Displays real screen dimensions
- Lists all visible windows (with minimized markers)
- One-click full-screen / desktop capture
- Shows thumbnails of recent screenshots

## One pitfall you must remember

**Do not hand-write screenshot commands with pwsh.** That path has no DPI declaration, and the output will always be 1536×864.

To take a screenshot, use `eye`.
