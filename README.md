# R1-Pokedex

A Pokédex-style bird & animal identifier for the **rabbit r1**, built as a
*creation* (self-hosted web app, installed by QR — no bootloader unlock, warranty intact).

Audio ID via **BirdNET**; photo ID via a vision model over BYOK.

---

## Layout

```
probe/index.html      Device capability probe. Deploy this dir; open on the r1.
bench/                BirdNET V2.4 WebGL benchmark. Fork of georg95/birdnet-web
                        with its two silent-hang bugs fixed; every await is
                        watchdogged so a hang names its own stage.
tools/make-qr.js      Generate a creation-install QR:
                        node make-qr.js <out.svg> <title> <url> [desc] [themeColor]
tools/qrcode.js       Vendored qrcode-generator (no CDN dependency).
tools/install.html    Interactive QR builder — open in a real browser, not a preview pane.
qr/                   Generated install QRs.
```

Deploy: `git push` → GitHub Pages serves [/probe/](https://sebbyteadev.github.io/R1-Pokedex/probe/)
and [/bench/](https://sebbyteadev.github.io/R1-Pokedex/bench/). Scan the QR in `qr/` once.
The r1 re-fetches the page every launch, so pushing updates it without re-scanning.

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
species card.

**Measured 2026-09-01: it's far better than that.** See below — 882 ms/chunk,
3.4× realtime. Continuous monitoring is no longer ruled out on speed grounds.

---

## BirdNET WebGL bench, measured on-device (2026-09-01)

`bench/` — BirdNET V2.4, TF.js WebGL backend, 3 s chunk, 5 runs.

| | r1 | Desktop ref | Note |
|---|---|---|---|
| Backend | webgl v2 | webgl v2 | |
| Model load (52 MB) | 3970 ms | — | consistent across runs |
| **Warmup** (shader compile) | **4281 ms** | 5672 ms | one-time; *faster* than desktop |
| **Inference, median** | **882 ms** | 30 ms | 29× slower |
| Inference, steady state | ~830 ms | — | run 5 of 5; still descending |
| **Realtime factor** | **×3.40** | ×101 | |
| Top species | Black-capped Chickadee | Black-capped Chickadee | ranking agrees ✅ |
| Confidence | **0.69** | **0.81** | ⚠️ see precision, below |

**Open question #1 is answered: under 2 s, so inference stays on-device.**

**Warmup was never the risk.** 4281 ms of shader compile on the GE8320, *less*
than the same code costs on desktop. The earlier 5322 ms figure came from
upstream's timer, which runs until `loaded` and so also covers the 7 MB geo
model and 520 KB of label files.

**The confidence gap is the real finding, and its cause is still open.** Same
input, same weights, deterministic math — 0.81 desktop vs 0.69 on-device.

Measured on-device, against an RTX 4090 reference:

| Probe | r1 (PowerVR) | Desktop ref | Verdict |
|---|---|---|---|
| `render f32` / `force f16` | true / false | true / false | storage fp32 ✅ |
| `highp` mantissa | 23b | 23b | ALU is fp32 ✅ |
| `mediump` mantissa | **10b** | 23b | ⚠️ latent trap |
| cos err @2π | **2.4e-5** | 6.4e-7 | 37× worse ⚠️ |
| cos err @3000 rad | 1.2e-7 | 2.9e-4 | 2400× better |
| `pow` rel err | 1.3e-7 | 1.3e-7 | identical ✅ |
| **STFT checksum** | **8293.712** | 8293.448 | **diverges** ⚠️ |

- **Ruled out: f16 texture fallback.** Storage precision is fp32, same as desktop.
- **Ruled out: fp16 ALU.** `highp` is a full 23-bit mantissa.
- **Ruled out: GLSL `pow`.** 1.3e-7 relative error, identical to desktop.
- **Convicted: the STFT front-end.** Running the kernel alone on a fixed
  signal gives checksum **8293.712** on the r1 vs **8293.448** on desktop —
  3.2e-5 relative divergence across 15903 deterministic values.

**Mechanism.** The kernel calls `cos`/`sin` at two different argument ranges,
and they behave oppositely on this GPU:

| Pass | Argument range | r1 vs desktop |
|---|---|---|
| Windowing (once) | up to ~3000 rad | 2400× **better** |
| Butterflies (×9) | `(π/len)*(k%len)` ∈ [0, π] | 37× **worse** |

The butterflies dominate — nine stages of compounding — and they sit squarely
in the small-argument regime where PowerVR is the weaker of the two. Measured
STFT divergence (3.2e-5) is the same order as the measured cos error near 2π
(2.4e-5). *Do not conclude "transcendentals are fine" from the large-argument
number alone; that was an early wrong turn here.*

**Fix available:** precompute the twiddle factors into a lookup texture instead
of evaluating `cos`/`sin` per shader invocation. Removes the error source
entirely and is likely also faster — 9 stages × 513 bins of transcendental
evaluation per chunk becomes a texture fetch.

**Caveat, unproven:** 3.2e-5 at the front end producing 0.81 → 0.69 at the
output implies ~2e4 amplification through the conv stack. Large but not
impossible for a deep net. The STFT divergence is established; that it fully
accounts for the confidence gap is not.

**`mediump` being 10b on the r1 and 23b on desktop is a trap worth
remembering** even though it isn't the current cause. Desktop GPUs promote
mediump to fp32, so a precision bug in any shader written later will be
invisible in development and only appear on the device. tfjs uses `highp`
throughout, which is why it isn't biting here.

Whatever the cause, the consequence already holds: top-1 ranking survives, but
**confidence values are not portable.** Any detection threshold must be
calibrated on the device, not on desktop, or quiet birds fall below it as
false negatives.

**Continuous listening is back on the table.** At 3.4× realtime the GPU
consumes audio faster than it arrives, so a rolling monitor is architecturally
possible. The earlier "point-and-identify, not a continuous monitor" verdict
was a CPU/WASM extrapolation made before WebGL was measured. Still unmeasured
and still decisive: sustained GPU load, thermals, and battery.

---

## Open questions

1. ~~**Does the BirdNET WebGL benchmark actually run?**~~ **Answered 2026-09-01:
   882 ms/chunk, ×3.40 realtime — inference stays on-device.** See the bench
   table above. Successor question: **why is on-device confidence 0.69 vs
   desktop 0.81?** **Localized:** the STFT front-end diverges (checksum
   8293.712 vs 8293.448), driven by small-argument `cos`/`sin` error compounding
   through nine butterfly stages. Fix is a twiddle-factor lookup texture.
   Whether that closes the full confidence gap is untested.
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
- **Host on GitHub Pages, not Netlify Drop.** Drop mints a *new site per
  deploy*, so every redeploy silently invalidates the printed QR. Pages gives a
  stable URL — changes are a `git push` and the same QR keeps working.
- **Never put a site password in front of a creation.** The WebView hits the
  form with no keyboard, and same-origin worker scripts 401 behind it.

### Upstream bugs in georg95/birdnet-web — do not rediscover

`test-chirpity.html` cannot complete a run. Both failures present identically:
the page sits on a stage forever with **no error**, because the worker's
rejection never reaches the page. `bench/` is a fork that fixes both and
reports every failure.

- **Hangs at `Warm up...`** — `birdnet.js:5` reads `?lang=`; absent, it's
  `null`, and `null.split('-')` throws *after* warmup and *before* it posts
  `loaded`. Workaround on the upstream page: append `&lang=en_us`.
- **Hangs at `Inference...`** — the page posts audio as `audioBuf`, the worker
  reads `data.pcmAudio`. `undefined.length` throws. No workaround; the test
  page has bit-rotted away from the worker it drives.
- **`fast_fft=on` is a no-op.** `birdnet.js` never reads that parameter — the
  page only echoes it into the log. It is not a setting.
- **`file-upload-demo.html` is not a substitute on the r1.** It sends the right
  field name, but gates loading behind `navigator.geolocation.getCurrentPosition`
  and needs `<input type="file">`, which requires WebView `onShowFileChooser`.
- The worker hardcodes site-root paths (`/birdnet-web/...`) for the geo model
  and labels, so it only runs under that path on `georg95.github.io`. The model
  is served with `Access-Control-Allow-Origin: *`, so a fork can load it
  cross-origin without mirroring 52 MB.

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
