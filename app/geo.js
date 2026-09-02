// Range model worker — deliberately CPU, deliberately separate.
//
// This model ran inside the BirdNET worker on the WebGL backend and produced
// GARBAGE on the r1: measured output on-device was 0.4470 - 0.520, avg 0.481,
// i.e. sigmoid(0) for all 6522 classes, against 0.0006 - 0.959 on desktop for
// the identical input. Every species then cleared the "nearby" threshold,
// which is exactly why the count read 6511 — the species total.
//
// The architecture explains the sensitivity: each of lat/lon/week is expanded
// into 48 phase-shifted sinusoids before three dense layers, and this GPU is
// already measured at ~37x worse small-argument sin/cos than desktop. Rather
// than chase which op degrades, run it on the CPU: it is three dense layers,
// the largest 512x6522, so roughly 6.7 MFLOP — about 60 ms at this device's
// measured 114 MFLOP/s, and it runs once per ZIP or week change.
//
// It lives in its own worker because tf.setBackend() is global to a tfjs
// instance: switching the BirdNET worker to CPU would strand its 49 MB of
// weights on the GPU backend.
//
// Protocol:
//   -> {message:'geo', lat, lon, week, labels:[...]}
//   <- {message:'geo', nearby:[...], tiers, stats}
//   any failure  <- {message:'error', where, error}

importScripts('./vendor/tf.min.js')

var BASE = '../models/birdnet/'
var model = null
var labels = null

var NON_SPECIES = {
    'Dog': 1, 'Engine': 1, 'Environmental': 1, 'Fireworks': 1, 'Gun': 1,
    'Human non-vocal': 1, 'Human vocal': 1, 'Human whistle': 1,
    'Noise': 1, 'Power tools': 1, 'Siren': 1
}
// The model clamps logits to +/-15, so 0.000553 is a hard floor meaning
// "definitively not in range" rather than a small probability.
var GEO_FLOOR = 0.00056
// The RARE tier floor. Lower cutoffs pad the list with species recorded once a
// decade — at 0.0025 San Francisco returned albatrosses and a desert Verdin.
var NEARBY_MIN = 0.02

function fail(where, e) {
    postMessage({ message: 'error', where: where, error: (e && e.stack) || String(e) })
}
self.addEventListener('error', function (e) { fail('geoworker', e.message) })
self.addEventListener('unhandledrejection', function (e) { fail('geoworker', e.reason) })

async function load() {
    if (model) { return }
    postMessage({ message: 'geo_loading' })
    await tf.setBackend('cpu')
    await tf.ready()
    if (!labels) {
        labels = (await fetch(BASE + 'labels/en_us.txt').then(function (r) {
            if (!r.ok) { throw new Error('labels ' + r.status) }
            return r.text()
        })).split('\n')
    }
    model = await tf.loadGraphModel(BASE + 'area-model/model.json')
}

async function run(d) {
    await load()
    // Raw degrees and a 1..48 week — the scaling is baked into the graph, so
    // pre-normalising would apply it twice. Never pass week = -1: it reads as
    // year-round in the docs but the mask is a constant in this export, so it
    // silently aliases to late November.
    var t = tf.tensor2d([[d.lat, d.lon, d.week]], [1, 3], 'float32')
    var out = model.predict(t)
    var scores = await out.data()          // already sigmoid-passed
    t.dispose()
    out.dispose()

    var near = [], mn = 1, mx = 0, sum = 0
    var tiers = { common: 0, uncommon: 0, rare: 0, veryRare: 0, exceptional: 0 }
    for (var i = 0; i < scores.length; i++) {
        var v = scores[i]
        if (v < mn) { mn = v }
        if (v > mx) { mx = v }
        sum += v
        var parts = (labels[i] || '_').split('_')
        var sci = parts[0]
        if (NON_SPECIES[sci]) { continue }
        if (v >= 0.30) { tiers.common++ }
        else if (v >= 0.08) { tiers.uncommon++ }
        else if (v >= 0.02) { tiers.rare++ }
        else if (v >= 0.0025) { tiers.veryRare++ }
        else if (v > GEO_FLOOR) { tiers.exceptional++ }
        if (v > NEARBY_MIN) {
            near.push({ sci: sci, common: parts[1] || sci, score: v })
        }
    }
    near.sort(function (a, b) { return b.score - a.score })

    postMessage({
        message: 'geo', week: d.week, nearby: near, tiers: tiers,
        stats: { min: mn, max: mx, mean: sum / scores.length,
                 lat: d.lat, lon: d.lon, backend: tf.getBackend() }
    })
}

onmessage = function (ev) {
    var d = ev.data
    if (!d) { return }
    if (d.message === 'ping') {
        postMessage({ message: 'pong', stage: 'geo', geo: !!model })
        return
    }
    if (d.message === 'geo') { run(d).catch(function (e) { fail('geo', e) }) }
}
