// YAMNet worker — the everyday-animal gap BirdNET cannot fill.
//
// BirdNET identifies 6511 wild species but has exactly one dog class and no
// cat, horse or cattle at all. YAMNet covers those, and is cheap: 16 MB
// against BirdNET's 49, Apache 2.0, and Google publishes a pre-converted TF.js
// build so there is no conversion step.
//
// It also sidesteps this project's hardest problem entirely: the graph has NO
// FFT ops — the STFT is baked in as constant DFT matrices applied via MatMul —
// so none of the custom STFT kernel or the PowerVR precision work applies.
//
// Deliberately NOT used for birds. YAMNet's best bird answer is the word
// "Bird"; BirdNET gives a species. See app/data/yamnet.json.
//
// Protocol:
//   -> {message:'classify', pcm: Float32Array(144000) @48kHz}
//   <- {message:'yam', top:[{name, taxon, confidence}], ms}
//   any failure  <- {message:'error', where, error}

importScripts('./vendor/tf.min.js')

var BASE = '../models/yamnet/'
var MAP = null
var model = null

function fail(where, e) {
    postMessage({ message: 'error', where: where, error: (e && e.stack) || String(e) })
}
self.addEventListener('error', function (e) { fail('worker', e.message) })
self.addEventListener('unhandledrejection', function (e) { fail('worker', e.reason) })

/* 48000 -> 16000 is an exact 3:1 ratio, but dropping to every third sample —
 * or averaging each group of three — is NOT enough. A 3-tap box filter has a
 * hopeless stopband, so everything above the new 8 kHz Nyquist folds back.
 * Bird calls run past 10 kHz, and the aliased result made YAMNet read the
 * reference chickadee as "Vehicle / Traffic noise / Police siren".
 *
 * So: windowed-sinc low-pass at ~7.4 kHz, then decimate. Only the kept samples
 * are computed (polyphase), so this is 48000 x 63 MACs, ~26 ms at the r1's
 * measured 114 MFLOP/s — cheap against a ~900 ms inference.
 */
var TAPS = 63, FC = 0.154;      // cutoff / sample-rate, just under 1/6
var FIR = (function () {
    var h = new Float32Array(TAPS), mid = (TAPS - 1) / 2, sum = 0;
    for (var i = 0; i < TAPS; i++) {
        var n = i - mid;
        var s = n === 0 ? 2 * FC : Math.sin(2 * Math.PI * FC * n) / (Math.PI * n);
        var w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (TAPS - 1));   // Hamming
        h[i] = s * w;
        sum += h[i];
    }
    for (var j = 0; j < TAPS; j++) { h[j] /= sum; }                     // unity DC gain
    return h
})()

// YAMNet wants a RANK-1 tensor, not [1, N] — [1, N] fails at the first Reshape.
function to16k(pcm) {
    var n = pcm.length / 3 | 0
    var out = new Float32Array(n)
    var mid = (TAPS - 1) / 2
    for (var j = 0; j < n; j++) {
        var c = j * 3, acc = 0
        for (var k = 0; k < TAPS; k++) {
            var idx = c + k - mid
            if (idx >= 0 && idx < pcm.length) { acc += pcm[idx] * FIR[k] }
        }
        out[j] = acc
    }
    return out
}

/* YAMNet expects a properly-levelled waveform and does NOT normalise
 * internally — unlike BirdNET, whose mel layer rescales every chunk, which is
 * why BirdNET copes with this mic and YAMNet does not.
 *
 * The r1's measured mic peak is 0.0175 and the reference clip's RMS is 0.0017.
 * Fed raw, YAMNet reads that as near-silence and answers "Inside, small room"
 * at 1.000 with every other class at zero. Peak-normalising fixes it.
 *
 * The floor matters: amplifying true silence by 500x just manufactures noise
 * for the model to hallucinate on, so leave very quiet input alone.
 */
function normalize(x) {
    var peak = 0
    for (var i = 0; i < x.length; i++) {
        var a = x[i] < 0 ? -x[i] : x[i]
        if (a > peak) { peak = a }
    }
    if (peak < 1e-4) { return x }          // genuine silence — do not amplify
    var g = 0.9 / peak
    for (var j = 0; j < x.length; j++) { x[j] *= g }
    return x
}

async function load() {
    if (model) { return }
    postMessage({ message: 'yam_loading' })
    MAP = await fetch('data/yamnet.json').then(function (r) { return r.json() })
    model = await tf.loadGraphModel(BASE + 'model.json')
}

async function classify(pcm, debug) {
    await load()
    var t0 = performance.now()
    var sig = normalize(to16k(pcm))
    var x = tf.tensor1d(sig)
    // Name the output. The graph emits three tensors — Identity:0 scores
    // [frames,521], Identity_1:0 embeddings [frames,1024], Identity_2:0
    // spectrogram [frames,64] — and predict() returns them in GRAPH order,
    // which is not guaranteed to match the signature order. Taking out[0] on
    // faith produced a saturated nonsense class.
    var scoresT = model.execute(x, 'Identity:0')
    var scores = await scoresT.array()
    x.dispose()
    scoresT.dispose()

    // Max over frames per class: a dog barking once in three seconds should
    // not be averaged away by the silence around it.
    var best = {}
    for (var f = 0; f < scores.length; f++) {
        var row = scores[f]
        for (var k in MAP.idx) {
            var i = +k
            if (row[i] > (best[MAP.idx[k]] || 0)) { best[MAP.idx[k]] = row[i] }
        }
    }
    var top = []
    for (var name in best) {
        if (best[name] > 0.10) {
            top.push({ name: name, taxon: MAP.taxon[name] || 'mammal', confidence: best[name] })
        }
    }
    top.sort(function (a, b) { return b.confidence - a.confidence })

    // An empty result is the right answer for birdsong, but it cannot be told
    // apart from a broken model without seeing the raw classes. debug:true
    // returns the highest-scoring indices so that distinction is checkable.
    var raw = null
    if (debug) {
        var peak = new Float32Array(scores[0].length)
        for (var f2 = 0; f2 < scores.length; f2++) {
            for (var i2 = 0; i2 < peak.length; i2++) {
                if (scores[f2][i2] > peak[i2]) { peak[i2] = scores[f2][i2] }
            }
        }
        raw = []
        for (var i3 = 0; i3 < peak.length; i3++) { raw.push([i3, peak[i3]]) }
        raw.sort(function (a, b) { return b[1] - a[1] })
        raw = raw.slice(0, 25)
    }

    if (debug) {
        var rms = 0
        for (var q = 0; q < sig.length; q++) { rms += sig[q] * sig[q] }
        rms = Math.sqrt(rms / sig.length)
        postMessage({ message: 'yam', top: top.slice(0, 3), raw: raw,
                      frames: scores.length, classes: scores[0].length, rms: rms,
                      ms: performance.now() - t0 })
        return
    }
    postMessage({ message: 'yam', top: top.slice(0, 3), raw: raw, ms: performance.now() - t0 })
}

onmessage = function (ev) {
    var d = ev.data
    if (!d || d.message !== 'classify') { return }
    classify(d.pcm, d.debug).catch(function (e) { fail('classify', e) })
}
postMessage({ message: 'yam_ready' })
