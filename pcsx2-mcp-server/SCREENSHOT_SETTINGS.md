# pcsx2_get_screenshot — recommended defaults

Read this before calling `pcsx2_get_screenshot` in a new session. It documents
token/legibility tradeoffs found through manual testing, so you don't have to
re-derive them each time.

## TL;DR default
Unless the user asks for something else, call it as:

```
format: "jpg"
width: 320
height: 240
quality: 70
```

~13 KB on the wire, ~100 tokens as an image (image tokens ≈ width*height/750,
NOT file size in KB — quality/format only affect transfer size, not token
cost). Confirmed legible at this setting: large/clear HUD elements (e.g. a
currency counter like "280267" bolts) read correctly. Small dense HUD text
may not.

## When to go bigger
If the user needs to read small/dense HUD text, tiny icons, or wants
pixel-accurate inspection (e.g. correlating with GS register state), step up:

| Use case | width x height | format/quality | ~tokens |
|---|---|---|---|
| Default / general "what's on screen" | 320x240 | jpg q70 | ~100 |
| Small HUD text needs to be certain | 384x288 or 480x360 | jpg q75-80 | ~150-230 |
| Pixel-exact / GS debugging | 0x0 (native, ~682x512) | png | ~465 |

## Rules of thumb
- Res drives token cost, not format/quality — jpg/webp only shrink file size,
  not token count. Don't reach for quality to save tokens; reach for width/height.
- Native res (width=0, height=0) is expensive (~465 tokens) — only use it when
  precision actually matters, not as a default "just in case."
- If unsure whether current settings are legible enough, just ask the user to
  read a specific on-screen value back to you as a check, rather than guessing.

## Still adjustable
This is a *default*, not a hard rule. If token budget is generous or the task
needs more/less fidelity, change width/height/format/quality per-call as
needed — just be aware bigger frames cost more tokens (see table above).
