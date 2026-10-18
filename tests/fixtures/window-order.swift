// Prints macOS's on-screen window list, front to back, as JSON: one entry per
// window with its owner pid, window number, layer and bounds. Read-only — it
// creates no window, activates nothing and records no window names or content.
// Compiled and run by `tests/e2e/background-window.spec.ts`.
import CoreGraphics
import Foundation

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
let entries: [[String: Any]] = windows.enumerated().map { index, window in
  [
    "index": index,
    "pid": window[kCGWindowOwnerPID as String] ?? -1,
    "number": window[kCGWindowNumber as String] ?? -1,
    "layer": window[kCGWindowLayer as String] ?? -999,
    "bounds": window[kCGWindowBounds as String] ?? [String: Any](),
  ]
}
let data = try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
