# R1-Pokedex

A Pokédex-style bird & animal identifier for the **rabbit r1**, built as a
*creation* (self-hosted web app, installed by QR — no bootloader unlock, warranty intact).

Audio ID via **BirdNET**; photo ID via a vision model over BYOK.

**Scope: personal, non-commercial, for fun.** This is a settled constraint, not
a placeholder — it means BirdNET V2.4 (CC BY-NC-SA) is fine to build on, and
that simple-but-lossy beats correct-but-complex wherever the two compete.

---

## Layout

```
app/                  **The Pokedex.** PTT -> 3 s -> species card, collection
                        persisted, runs fully offline. See App below.
probe/index.html      Device capability probe. Deploy this dir; open on the r1.
bench/                BirdNET V2.4 WebGL benchmark. Fork of georg95/birdnet-web
                        with its two silent-hang bugs fixed; every await is
                        watchdogged so a hang names its own stage. Runs fully
                        offline — SAVE FOR OFFLINE precaches the model.
models/birdnet/       Mirrored BirdNET V2.4 weights (13 shards, 48.9 MB) +
                        labels. Same-origin so the service worker can cache
                        them; CC BY-NC-SA 4.0, see Model notes.
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

## App

`app/` — [sebbyteadev.github.io/R1-Pokedex/app/](https://sebbyteadev.github.io/R1-Pokedex/app/)

**Controls.** PTT (`sideClick`) identifies; scroll down opens the dex; scroll up
at the top of the dex returns. Pointer taps do the same so it is testable in a
desktop browser.

**`sideClick` fires; holding PTT does nothing.** `longPressStart` /
`longPressEnd` produced no events on-device, so press-to-identify is the real
interaction and hold is not advertised in the UI. The listeners are still
registered, and the title bar shows the last hardware event received, so if a
firmware update starts dispatching them it will be visible rather than assumed.

**Live spectrogram** during the 3 s capture: y is frequency (0–15 kHz, the band
BirdNET's mel front-end actually uses), x is time. Columns are drawn against
**capture progress, not frame rate** — tying them to `requestAnimationFrame`
filled the panel at whatever rate the device rendered, which on a throttled tab
was ~10 columns of 180 in 1.6 s. It stays up through inference, because ~0.9 s
of blank screen reads as a freeze.

**Flow.** Hold PTT → 3 s capture at 48 kHz mono with AGC/NS/AEC disabled →
144000 float samples straight into BirdNET, no resampling → species card with
scientific name, confidence, runners-up, and a NEW badge on first sighting.
Every hit is written to the collection.

**Decisions that came from measurement, not taste:**

| | |
|---|---|
| `THRESHOLD = 0.15` | **Tune on-device.** Desktop scored 0.81 where the r1 scored 0.69 on the same clip; confidence does not transfer |
| `LOCKOUT_MS = 800` | Eight rapid PTT taps shut the r1 down. We cannot stop the taps, but we refuse to pile work on them |
| `whenSDKReady` before storage | `creationStorage` is late-injected; a startup check returns false then true |
| Capture fails loudly off 48 kHz | Silently resampling would corrupt the model's input |
| No touch handlers | `preventDefault` on touch crashes the WebView ~3 s later |
| Sigmoid not reapplied | The TF.js export has it baked in |

**Storage** prefers `creationStorage` (host-backed, survives relaunch) and falls
back to `localStorage`, which also survived relaunch in testing — a real
fallback, not a token one.

**Offline** is automatic: the service worker caches the shell network-first and
the model cache-first, so the first online launch is the only one that fetches
weights. Verified booting to READY with the server stopped and the collection
intact.

---

## Measured on-device (2026-08-31)

| | Value | Note |
|---|---|---|
| **Viewport** | **240×292** | Docs say 240×282. Was misread as 240×152 — see below |
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

Name-checking was the wrong method — it missed four. Diffing `window` against a
clean `about:blank` window finds **7 host-injected globals**, measured:

```
AccelerometerHandler   CreationStorageHandler   CreationVoiceHandler
FlutterButtonHandler   PluginMessageHandler     TouchEventHandler
closeWebView
```

**The surface has two layers**, which is why guessing failed. The `*Handler`
globals are low-level Flutter bridges, each exposing only `postMessage`. The
API you actually write against is a separate, higher-level layer that the host
is also expected to inject — rabbit's own SDK demo
([rabbit-hmi-oss/creations-sdk](https://github.com/rabbit-hmi-oss/creations-sdk))
bundles no shim and calls it directly:

| Bridge | Developer API |
|---|---|
| `CreationStorageHandler` | `window.creationStorage.plain.setItem/getItem` (base64 values) |
| `AccelerometerHandler` | `window.creationSensors.accelerometer.start(cb, {frequency})` |
| `FlutterButtonHandler` | **plain DOM events on `window`** — see below |
| `PluginMessageHandler` | `.postMessage(JSON.stringify({message, useLLM, wantsR1Response}))`, reply via `window.onPluginMessage` |

**Hardware input needs no wrapper and works today:**

```js
window.addEventListener('scrollUp',       fn)
window.addEventListener('scrollDown',     fn)
window.addEventListener('sideClick',      fn)   // PTT
window.addEventListener('longPressStart', fn)
window.addEventListener('longPressEnd',   fn)
```

That is the whole PTT interaction, host-dispatched, no bridge protocol needed —
and better than touch events, which carry the `preventDefault` crash risk.

**The wrapper layer is late-injected — this is the single most important fact
about writing a creation.** The `__atStart` diff (captured in `<head>`) sees
only the 7 bridges; `window.creationStorage` and `window.creationSensors` are
absent then and present within 6 s. Verified on-device:

- `creationStorage` — **`setItem`/`getItem` round-trip OK, values persist** ✅
- `creationSensors.accelerometer.isAvailable()` — **true** ✅

Nothing was ever missing. The original "3 of 6 absent" was a one-shot check at
script-parse time, the same root cause as the 240×152 viewport: **both original
anomalies were measurements taken before the environment settled.**

```js
// Never do this at startup — it is false at parse time and true a moment later.
if (window.creationStorage) { ... }

// Wait for the SDK layer instead.
function whenSDKReady(cb, timeoutMs) {
  var t0 = Date.now();
  (function tick() {
    if (window.creationStorage && window.creationSensors) { return cb(true); }
    if (Date.now() - t0 > (timeoutMs || 8000)) { return cb(false); }
    setTimeout(tick, 50);
  })();
}
```

Always keep the `cb(false)` path working — availability is not guaranteed, and
rabbit's own demo guards for absence too.

**Docs say 240×282 throughout; the device measures 240×292. Trust the device.**

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

**Fixed** (`bench/birdnet-worker.js`): twiddle factors and the Hann window are
now precomputed in fp64 on the CPU and uploaded as fp32 tables, so the shader
does a texture fetch instead of a transcendental. One twiddle table serves both
the butterflies (`j = (k%len)*(innerDim/len)`) and the reassemble pass
(`j = i`, sine negated) — both reduce to `π·j/innerDim`.

The window pass also computed `cos(2π·q/frameLength)` with `q` up to ~500k.
Since `cos` is 2π-periodic and `q = coords[0]*frameLength + i`, that is
identically `cos(2π·i/frameLength)` — **the large argument was spurious**, and
it was what triggered ANGLE/D3D11's sloppy range reduction on desktop.

The bench now scores the kernel against an exact fp64 DFT rather than against
another GPU, so it measures accuracy instead of agreement. Desktop (RTX 4090):

| STFT implementation | err vs exact |
|---|---|
| in-shader `cos`/`sin` (upstream) | 8.6e-7 |
| **lookup tables** | **6.2e-8** — the fp32 floor, 14× better |

Species and timing unchanged on desktop (0.81, ~26 ms/chunk).

**On the r1 the fix worked — and disproved its own hypothesis.** Post-fix:
error vs exact 6.4e-7 (a few fp32 eps), checksum 2003.159 vs desktop's
2003.160, so cross-device divergence fell from 3.2e-5 to ~5e-7, about 60×.
**Confidence stayed at 0.69.** The STFT front-end is therefore *exonerated as
the cause of the confidence gap* — it was a genuine numerical defect worth
fixing, but not this symptom.

Keep the LUT anyway: the kernel is now correct rather than accidentally close,
it agrees across GPUs, and it costs nothing.

### Where the confidence gap actually lives — open

Ruled out, in order: f16 texture storage, fp16 ALU, loose transcendentals,
GLSL `pow`, and now the STFT front-end. What remains is the conv stack —
distributed fp32 accumulation differences across ~50 layers, plausibly from
tfjs selecting different kernel paths (packing, im2col, tile sizes) under the
r1's texture-size and capability limits. Different summation order, same
precision.

**NEARBY uses the RARE tier floor (0.02), not the model's noise floor.** At
0.0025 the San Francisco list ran to 235 and its tail was Black-footed
Albatross, Laysan Albatross, Eurasian Coot and Verdin — pelagic and desert
birds nobody in the Mission will hear. 0.02 gives 143 there, ending at Allen's
Hummingbird and Dunlin, which is a list you could actually work through. The
lower tiers still exist and still label an individual detection; they just do
not belong in "birds in your area".

**Recommended: stop here and calibrate on-device.** The divergence is
deterministic per device, so a threshold tuned on the r1 is exactly as good as
knowing why. A layer-by-layer bisect (build sub-models with
`tf.model({inputs, outputs: layer.output})` and find the first material
divergence) would give the answer, but there is no single site left to fix —
only an explanation.

**The practical rule stands regardless: confidence values are not portable
between desktop and device. Tune detection thresholds on the r1.**

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
   desktop 0.81?** **Still open, and deprioritized.** Five causes ruled out
   (see the precision section); the STFT defect was real and is fixed, but was
   not this. Remaining candidate is distributed fp32 accumulation across the
   conv stack — explainable, not fixable. Mitigation is to calibrate detection
   thresholds on-device, which is required regardless of the cause.
2. ~~**Why is the viewport 240×152?**~~ **Answered: it isn't.** It is
   **240×292**, identical across samples at t=0/100/500/1500/4000 ms, zero
   resize events, not in an iframe, safe-area insets all zero. The original
   figure came from a single sample taken at script-parse time, before the
   WebView had settled. Docs say 282; the truth is 292, and the host reserves
   28 px of the 320 px screen.

   **Design against 240×292, but do not hardcode it.** Use relative units and
   listen for `resize`. The 152 reading is not reproducible, which means its
   cause is unknown rather than absent — build so that a surprise viewport
   degrades instead of breaking.

   **The rabbit API surface: also answered — nothing was missing.** All 7
   bridges are present, and the `creationStorage` / `creationSensors` wrappers
   arrive within 6 s. Storage round-trips and the accelerometer reports
   available. The original "3 of 6" was a one-shot check run before injection,
   the same root cause as the viewport misread. See the API section above.
3. ~~**Offline.**~~ **Answered 2026-09-01: it works.** A service worker
   registers, activates, controls the page on subsequent launches, and **serves
   the shell with wifi off — the creation launches with no network.** All four
   stores survive relaunch (`localStorage`, `indexedDB`, `cacheAPI`,
   `creationStorage`), verified with launch counters reaching n=3 across
   online and offline launches.

   The premise that "the shell isn't cached between loads" was wrong, and the
   observation that zero of 600+ creations use a service worker looks like
   nobody having tried rather than evidence it can't work.

   **Done — the model is mirrored and offline inference works.** Weights live
   in `models/birdnet/` (13 shards, 48.9 MB) with labels and a 3 s test clip.
   `bench/sw.js` caches them; **SAVE FOR OFFLINE** precaches all 16 files on
   demand so the download is a deliberate act rather than a discovery made
   with no signal. Verified with the server stopped: shell, worker, model,
   labels and audio all served from cache, inference completed, correct
   species. Next optional win is the FP16 export (48.9 MB → ~26 MB).

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
- **A failed Pages build is invisible from the device, and looks like a broken
  app.** The `<meta name="build">` stamp catches a STALE page but not a deploy
  that never published: `index.html` and `version.json` are then both old and
  agree with each other. CFG -> CHECK DEPLOY compares the published stamp
  against repo HEAD on the GitHub API, because the repo advances even when the
  publish does not. Run `node tools/stamp-version.js` before every commit.
- **Keep `.nojekyll` at the repo root.** Without it Jekyll walks the whole tree
  on every push — a 28 MB photo blob, a 49 MB model, 16 MB of YAMNet weights —
  and Pages builds started failing outright once the repo passed ~100 MB.
- **Ship a build stamp and check it before debugging anything.** GitHub Pages
  sends `Cache-Control: max-age=600`, so relaunching within ten minutes of a
  push serves stale HTML. That is indistinguishable from a feature failing to
  appear, and it cost a debugging round here. `probe/index.html` carries a
  `<meta name="build">` and refetches itself with `cache: no-store` to compare.
- **Service workers must be network-first, not cache-first.** A cache-first
  shell would pin the creation to whatever it cached on install, with no way to
  push a fix to a device in the field. Network-first still gives full offline
  via the failed-fetch fallback — measured working with wifi off.

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

## BirdNET is not only birds

Of the 6522 labels, **11 are not animals** and **87 are not birds**:

| Group | Count | Examples |
|---|---|---|
| Birds | 6423 | |
| Amphibians | 41 | Spring Peeper, American Bullfrog, Gray Treefrog |
| Insects | 40 | Snowy Tree Cricket, Common True Katydid, Protean Shieldback |
| Mammals | 7 | Coyote, Gray Wolf, White-tailed Deer, Eastern Chipmunk |
| Not animals | 11 | Siren, Engine, Gun, Fireworks, Power tools, Human x3 |

So this is already a general animal identifier and simply was not saying so.
`app/data/taxa.json` (762 B) maps the 34 non-bird genera; everything else is a
bird.

**Classify by GENUS, never by common name.** Name matching produces 35 false
positives -- Bee-eaters, Grasshopper Warblers, Mouse-colored Antshrike, Squirrel
Cuckoo, Fox Sparrow, Bat Falcon, and *Killdeer* (contains "deer"). It also
misses `Atlanticus testaceus`, whose common name is "Protean Shieldback" and
contains no insect word at all.

The 11 non-animal labels are the model saying *"that was not an animal"*; they
surface as an INTERFERENCE result and are never recorded.

---

## Species photographs

All **6498 of 6511** species carry a bundled photo (99.80%). The 13 without are
11 crickets and two obscure birds; they fall back to a silhouette, which is the
Pokedex idiom anyway.

| | |
|---|---|
| Format | 256x256 WebP q70, cover-cropped from a 500px source |
| Total | **56.5 MB**, mean 9111 B per image |
| Packing | ONE blob + offset index, not 6498 files |
| Source | Wikimedia Commons via the Wikipedia pageimages API |
| Licences | zero NC, zero ND. 70% CC BY-SA, 22% CC BY, 7% PD/CC0 |

**Bundle, do not lazy-fetch.** 9 MB against a 49 MB model already cached is not
worth a network dependency, a cache-management bug surface, and offline gaps.

**One blob, not 6498 files.** On a 4KB-block filesystem individual files cost
~166% overhead — 10 MB of images occupying ~27 MB on the device — plus 6498
cache entries. `birds.idx.json` maps scientific name to `[offset, length]`.

**Do NOT use BirdNET's own taxonomy API for images.** It looks like the obvious
source, but **24% of it is Macaulay Library, all rights reserved**, and their
terms forbid third-party download. Hotlinking is fine; bundling is not.
iNaturalist is only ~15% as freely licensed as Commons and 9% is ND, which
forbids the cropping. Commons is the answer.

Two traps in the harvest, both fixed in `tools/harvest-images.py`:

- **Arbitrary thumbnail widths return HTTP 400.** Only 60/120/250/330/500 are
  valid buckets, so a request for 240 fails.
- **Fetch the 500 bucket, not 250.** Cover-cropping to a square keeps only the
  SHORT side, so a 250px-wide landscape photo yields a ~167px square. The pack
  was silently capped there: raising OUT_PX alone would have upscaled a 167px
  original into bigger files with no new detail. The bucket is just a path
  segment, so an existing meta.json can be reused by rewriting `/250px-`.
- **Immutable assets need versioned filenames.** `app/sw.js` caches
  `data/birds.*` cache-first, so a rebuilt pack under the same name would never
  reach a device holding the old one. Hence `birds-256.webpack`; the resolution
  is in the URL and a new pack is simply a new URL.
- **Redirect targets are many-to-one.** Several species share one article —
  *Acanthis flammea* and relatives all redirect to "Redpoll" — so a map keyed by
  destination title silently drops all but one. That is how a bird as common as
  the Common Redpoll first came back imageless.
- **MediaWiki normalises titles**, turning underscores into spaces, so joining
  `pageimage` ("A_B.jpg") against page titles ("A B.jpg") matched only the ~5%
  of filenames containing no underscore.

Attribution ships in `app/data/attribution.json` (308 KB, licences interned)
and is rendered on the result card — ~93% of these images require it. Full
credits with source URLs are in `NOTICE-images.txt`.

---

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
