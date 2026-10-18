# Renderer brand assets

Downscaled derivatives of the canonical originals in `resources/brand/`,
generated with `sips` at the source's native 1:1 aspect ratio:

| File | Source | Size |
| --- | --- | --- |
| `interleaf-logo.png` | `resources/brand/interleaf-logo.png` | 256×256 |

Only assets the renderer actually displays are copied here. The wordmark
(`resources/brand/interleaf-logo-wordmark.png`) has no UI placement, so it is
kept as a brand asset only and has no renderer copy.

This copy exists so the UI does not ship a ~1 MB 1254×1254 raster it never
displays at full size. Regenerate them from `resources/brand/` rather than
editing them; that directory holds the unmodified supplied artwork and is also
the source for `resources/icon.png` and the macOS iconset.
