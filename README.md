# R1-Pokedex

A Pokédex-style bird & animal identifier for the **rabbit r1**, built as a
*creation* (self-hosted web app, installed by QR — no bootloader unlock, warranty intact).

Audio ID via **BirdNET**; photo ID via a vision model over BYOK.

---

## Layout

```
probe/index.html      Device capability probe. Deploy this dir; open on the r1.
tools/make-qr.js      Generate a creation-install QR:
                        node make-qr.js <out.svg> <title> <url> [desc] [themeColor]
tools/qrcode.js       Vendored qrcode-generator (no CDN dependency).
tools/install.html    Interactive QR builder — open in a real browser, not a preview pane.
qr/                   Generated install QRs.
```

Deploy: drag `probe/` onto [Netlify Drop](https://app.netlify.com/drop) → scan `qr/r1-probe-qr.svg`.
The r1 re-fetches the page every launch, so redeploying updates it without re-scanning.

---

## Measured on-device (2026-08-31)

| | Value | Note |
|---|---|---|
| Viewport | **240×152** | Docs say 240×282 — see open questions |
| Screen / DPR | 240×320 / 2 | |
| Chrome (WebView) | **101** | 2022-era. Hard ceiling on modern APIs. |
| Android | 13 | |
| Cores / RAM | 8 / 4 GB | Cortex-A53, PowerVR GE8320 |
| **WebGL** | **webgl2** ✅ | Community claimed absent. It is present. |
| WebGPU | no | Needs Chrome 113+; PowerVR is allowlist-gated anyway |
| WASM / SIMD | yes / yes | Baseline SIMD only (relaxed SIMD needs Chrome 114+) |
| SharedArrayBuffer / threads | no / no | Android WebView can't grant cross-origin isolation |
| **CPU (scalar JS matmul)** | **114 MFLOP/s** | Desktop ref: 1293. ~11× slower. |
| Storage quota | **63.6 GB** | 8 MB write 289 ms → ~1.8 s for 50 MB |
| `storage.persisted()` | **no** | Cache is evictable; always keep a re-download path |
| **Mic** | **48 kHz, mono** ✅ | AGC / noise-supp / echo-cancel **all disabled OK**; peak 0.0175 |
| Camera | 480×640, 2 devices | `facingMode` accepted |

### Rabbit API surface actually present

✅ `PluginMessageHandler` · `TouchEventHandler` · `closeWebView`
❌ `creationStorage` · `CreationVoiceHandler` · `creationSensors`

---

## What this means

**The mic is the win.** 48 kHz mono raw with all DSP defeated is *exactly* BirdNET
V2.4's native input (`float32[1, 144000]` = 3 s × 48 kHz). No resampling, no
pre-normalization — the mel front-end is inside the model graph.

**The CPU is too slow for WASM inference.** 114 MFLOP/s extrapolates to ~13 s per
3-second chunk in scalar JS; even at WASM+SIMD's 2–4× that's 3–6 s. Continuous
listening on CPU is out.

**But WebGL2 exists**, so the GPU path routes around it. Cornell's official PWA
([birdnet-team/real-time-pwa](https://github.com/birdnet-team/real-time-pwa), MIT)
runs V2.4 in TensorFlow.js on a **WebGL-only** backend, with a hand-written GLSL
STFT kernel (tfjs ships no STFT op). That WebGL dependency — a liability if the
device had no GPU path — is the right architecture here.

**Plan: fork the PWA, keep its WebGL backend.** Do not port to WASM. Do not use
LiteRT.js (assumes a modern engine; Chrome 101 likely won't run it).

Even at 2–4 s per identification, the UX works: hold PTT → record 3 s →
species card. This is a point-and-identify gadget, not a continuous monitor.

---

## Open questions

1. **Does the BirdNET WebGL benchmark actually run?** — `qr/birdnet-bench-qr.svg`
   → [georg95/birdnet-web](https://github.com/georg95/birdnet-web) (upstream of Cornell's PWA).
   Watch **warmup** (shader compile on GE8320 could be ~10 s) and **ms/chunk**.
   Under ~2 s = product. Over ~6 s = inference goes server-side.
2. **Why are 3 of 6 rabbit APIs missing, and why is the viewport 240×152?**
   Both suggest the probe didn't load with full creation privileges.
   Resolve before designing a UI against the wrong dimensions.
3. **Offline.** A creation is fetched from its URL on *every* launch and the shell
   HTML isn't cached between loads — no network, no app. Zero of 600+ known
   creations use a service worker. Unexplored, and it matters for field birding.

## Constraints worth not rediscovering

- **Never `preventDefault()` on touch events** — WebView crashes ~3 s later.
  Use `pointerdown`/`pointerup`, never `touchstart`.
- **Eight rapid PTT taps shuts the device down.**
- No `onclick=` inside `innerHTML` strings — silent failure. Use `addEventListener`.
- No external web fonts.
- The motorized camera is **not reachable** — it's a root-only sysfs node
  (`/sys/devices/platform/step_motor_ms35774/orientation`). Only `facingMode`.
- Body must not scroll; implement scrolling yourself.

## Model notes

- **V2.4**: input `float32[1,144000]`, output `[1,6522]` **logits** (TFLite/ONNX)
  — but the **TF.js export has sigmoid baked in**; don't apply it twice.
- Sizes: TFLite FP32 51.7 MB · **FP16 25.9 MB** · INT8 41.1 MB (only ~21% smaller —
  the STFT/mel front-end stays float). TF.js export 52.2 MB, unquantized;
  re-running `--quantize_float16` should roughly halve it.
- Labels: one per line, line N = output index N, `Scientific_Common`.
- Skip the 7 MB geo model — precompute the regional prior into a 26 KB float array.
- **License: V2.4 weights are CC BY-NC-SA 4.0 — non-commercial.** Fine for personal
  use. If this ever goes commercial, build against V3.0-preview (CC BY-SA 4.0) from
  day one. Code is MIT. Not legal advice.
