// BirdNET V2.4 inference worker for the r1 Pokedex.
//
// Forked from bench/birdnet-worker.js, which is itself a fork of
// georg95/birdnet-web (MIT) with its two silent-hang bugs fixed. The
// benchmark's GPU precision probes are stripped; the STFT twiddle/window
// lookup tables are kept, since those are a correctness fix, not a
// measurement (see README: in-shader cos/sin cost real accuracy here).
//
// Protocol:
//   -> {message:'identify', pcm: Float32Array(144000)}
//   <- {message:'result', top:[{common, sci, confidence}], ms}
//   any failure  <- {message:'error', where, error}
// Vendored, not CDN. importScripts of a cross-origin URL is skipped by the
// service worker, so a CDN tfjs makes the worker fail offline with
// "NetworkError ... importScripts" even when everything else is cached.
// Same-origin means the SW serves it, and there is no CDN dependency in
// the field. Pinned to 4.22.0 (Apache-2.0).
importScripts('./vendor/tf.min.js')

// Same-origin, mirrored into this repo. Cross-origin worked, but the service
// worker skips cross-origin requests by design, so the model could never be
// cached for field use. Same-origin also drops the third-party dependency.
var BASE = '../models/birdnet/'

// BirdNET V2.4 emits 6522 labels, but 11 of them are not birds — they are the
// model's way of saying "that was not a bird". Verified against
// models/birdnet/labels/en_us.txt. Real species count is 6511.
var NON_SPECIES = {
    'Dog': 1, 'Engine': 1, 'Environmental': 1, 'Fireworks': 1, 'Gun': 1,
    'Human non-vocal': 1, 'Human vocal': 1, 'Human whistle': 1,
    'Noise': 1, 'Power tools': 1, 'Siren': 1
}

function fail(where, e) {
    postMessage({ message: 'error', where: where, error: (e && e.stack) || String(e) })
}
self.addEventListener('error', function (e) { fail('worker', e.message) })
self.addEventListener('unhandledrejection', function (e) { fail('worker', e.reason) })

main().catch(function (e) { fail('init', e) })

async function main() {
    var t = performance.now()
    await tf.setBackend('webgl')
    await tf.ready()
    t = performance.now()
    var labels = (await fetch(BASE + 'labels/en_us.txt').then(function (r) {
        if (!r.ok) { throw new Error('labels ' + r.status + ' from ' + r.url) }
        return r.text()
    })).split('\n')
    postMessage({ message: 'labels', count: labels.length, ms: performance.now() - t })

    t = performance.now()
    var model = await tf.loadLayersModel(BASE + 'model.json', {
        onProgress: function (p) { postMessage({ message: 'load_progress', progress: p }) }
    })
    postMessage({ message: 'model', ms: performance.now() - t })

    // resTensor.array() forces a GPU->CPU readback, so timings are real
    // end-to-end latency and not just kernel-enqueue time.
    async function predict(signal) {
        var res = model.predict(signal)
        signal.dispose()
        var out = await res.array()
        res.dispose()
        return out
    }

    t = performance.now()
    await predict(tf.zeros([1, 144000]))
    postMessage({ message: 'warmup', ms: performance.now() - t })

    /* ---------- range model ----------
       Separate 6.8MB graph model: [lat, lon, week] -> per-label occurrence.
       Loaded lazily on the first geo request so a user with no ZIP set never
       pays for it, and never before 'ready' so it cannot delay first capture. */
    var areaModel = null
    var geoScores = null                 // per-label occurrence for the saved ZIP
    // The model clamps its logits to +/-15, so 0.000553 is a hard floor meaning
    // "definitively not in range" — a distinct class, not a small probability.
    var GEO_FLOOR = 0.00056
    var NEARBY_MIN = 0.0025              // below this is not worth listing

    var speciesSci = labels.map(function (l) { return l.split('_')[0] })
    var speciesCommon = labels.map(function (l) {
        var p = l.split('_'); return p[1] || p[0]
    })

    async function geo(data) {
        if (!areaModel) {
            postMessage({ message: 'geo_loading' })
            areaModel = await tf.loadGraphModel(BASE + 'area-model/model.json')
        }
        // Raw degrees and a 1..48 week. The scaling is baked into the graph, so
        // pre-normalizing would double-apply it. Upstream's own caller computes
        // a 1..53 week, which extrapolates past the trained domain, and passes
        // -1 for "year-round" — but in this export the year-round mask is a
        // constant, so -1 silently aliases to late November instead.
        var t = tf.tensor2d([[data.lat, data.lon, data.week]], [1, 3], 'float32')
        var out = areaModel.predict(t)
        // Output is already sigmoid-passed; do not squash it again. Values are
        // eBird checklist frequency, clamped to [0.000553, 0.999447], where the
        // low value is a hard floor meaning "not expected here at all".
        geoScores = await out.data()
        t.dispose()
        out.dispose()

        // Build the NEARBY list here rather than shipping 6522 labels to the
        // page just so it can join them against an array.
        var near = []
        for (var i = 0; i < geoScores.length; i++) {
            if (geoScores[i] > NEARBY_MIN && !NON_SPECIES[speciesSci[i]]) {
                near.push({ sci: speciesSci[i], common: speciesCommon[i], score: geoScores[i] })
            }
        }
        near.sort(function (a, b) { return b.score - a.score })
        postMessage({
            message: 'geo',
            week: data.week,
            nearby: near,
            tiers: countTiers(geoScores)
        })
    }

    function countTiers(s) {
        var t = { common: 0, uncommon: 0, rare: 0, veryRare: 0, exceptional: 0 }
        for (var i = 0; i < s.length; i++) {
            if (NON_SPECIES[speciesSci[i]]) { continue }
            var v = s[i]
            if (v >= 0.30) { t.common++ }
            else if (v >= 0.08) { t.uncommon++ }
            else if (v >= 0.02) { t.rare++ }
            else if (v >= 0.0025) { t.veryRare++ }
            else if (v > GEO_FLOOR) { t.exceptional++ }
        }
        return t
    }

    onmessage = function (ev) {
        var d = ev.data
        if (d && d.message === 'geo') {
            geo(d).catch(function (e) { fail('geo', e) })
            return
        }
        run(d).catch(function (e) { fail('identify', e) })
    }
    postMessage({ message: 'ready' })

    async function run(data) {
        if (data.message !== 'identify') { return }
        var pcm = data.pcm
        if (!pcm || pcm.length !== 144000) {
            throw new Error('expected 144000 samples, got ' + (pcm && pcm.length))
        }
        var t0 = performance.now()
        var out = await predict(tf.tensor(pcm, [1, 144000]))
        var scores = out[0]

        // The TF.js export has sigmoid baked in — these are probabilities
        // already. Do not apply it a second time (see README, Model notes).
        var top = []
        for (var i = 0; i < scores.length; i++) {
            if (scores[i] > 0.03) {
                var parts = (labels[i] || '_').split('_')
                var sci = parts[0] || '?'
                top.push({
                    sci: sci,
                    common: parts[1] || sci,
                    confidence: scores[i],
                    // 11 of the 6522 labels are not birds. Flag them here so the
                    // UI can report interference instead of filing a passing
                    // siren in the collection as a species.
                    noise: NON_SPECIES[sci] === 1,
                    // null when no ZIP is set — the UI must not render a rarity
                    // it does not have. -1 marks the model's off-range floor.
                    geo: geoScores ? (geoScores[i] <= GEO_FLOOR ? -1 : geoScores[i]) : null
                })
            }
        }
        top.sort(function (a, b) { return b.confidence - a.confidence })
        postMessage({
            message: 'result',
            top: top.slice(0, 3),
            ms: performance.now() - t0
        })
    }
}

// ---- MelSpecLayerSimple + WebGL STFT kernel: verbatim from upstream ----

class MelSpecLayerSimple extends tf.layers.Layer {
    constructor(config) {
        super(config)
        this.sampleRate = config.sampleRate
        this.specShape = config.specShape
        this.frameStep = config.frameStep
        this.frameLength = config.frameLength
        this.melFilterbank = tf.tensor2d(config.melFilterbank)
    }
    build(inputShape) {
        this.magScale = this.addWeight(
            'magnitude_scaling',
            [],
            'float32',
            tf.initializers.constant({ value: 1.23 })
        );
        super.build(inputShape)
    }
    computeOutputShape(inputShape) {
        return [inputShape[0], this.specShape[0], this.specShape[1], 1];
    }
    call(inputs) {
        return tf.tidy(() => {
        inputs = inputs[0]
        return tf.stack(inputs.split(inputs.shape[0]).map((input) => {
                let spec = input.squeeze()
                spec = tf.sub(spec, tf.min(spec, -1, true))
                spec = tf.div(spec, tf.max(spec, -1, true).add(0.000001))
                spec = tf.sub(spec, 0.5)
                spec = tf.mul(spec, 2.0)
                spec = tf.engine().runKernel('STFT', { signal: spec, frameLength: this.frameLength, frameStep: this.frameStep })
                spec = tf.matMul(spec, this.melFilterbank)
                spec = spec.pow(2.0)
                spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))))
                spec = tf.reverse(spec, -1)
                spec = tf.transpose(spec)
                spec = spec.expandDims(-1)
                return spec;
            }))
        })
    }
    static get className() { return 'MelSpecLayerSimple' }
}
tf.serialization.registerClass(MelSpecLayerSimple)

// ---- Twiddle / window lookup tables ------------------------------------
//
// Upstream evaluates cos/sin per shader invocation. Measured on the r1
// (PowerVR GE8320): small-argument cos is 37x less accurate than desktop,
// and the nine butterfly stages all sit in that range, compounding. That
// showed up as an STFT checksum divergence of 3.2e-5 and a species
// confidence of 0.69 vs desktop's 0.81.
//
// Both tables are computed here in fp64 and uploaded as fp32, so the shader
// does a texture fetch instead of a transcendental. Exact on every GPU, and
// cheaper: 9 stages x 513 bins of cos/sin per chunk becomes a lookup.
//
// tw[j] = (cos(pi*j/innerDim), sin(pi*j/innerDim)), j = 0..innerDim
//   butterflies: t = (pi/len)*(k%len), so j = (k%len)*(innerDim/len).
//     len and innerDim are both powers of two, so the stride is exact.
//   reassemble:  t = -pi*i/innerDim, so j = i and the sine is negated.
//     needs j == innerDim, hence the +1 entry.
//
// win[i] = 0.5 - 0.5*cos(2*pi*i/frameLength)
//   Upstream computes cos(2*pi*q/frameLength) with q up to ~500k. cos is
//   2*pi-periodic and q = coords[0]*frameLength + i, so that is identically
//   cos(2*pi*i/frameLength) — the large argument is spurious, and it is
//   what triggers ANGLE/D3D11's sloppy range reduction (2.9e-4 on desktop).

var TWIDDLE_CACHE = {}
var WINDOW_CACHE = {}

function twiddleLUT(innerDim) {
    if (!TWIDDLE_CACHE[innerDim]) {
        var d = new Float32Array((innerDim + 1) * 2)
        for (var j = 0; j <= innerDim; j++) {
            var t = Math.PI * j / innerDim
            d[j * 2] = Math.cos(t)
            d[j * 2 + 1] = Math.sin(t)
        }
        // keep(): the kernel runs inside MelSpecLayerSimple's tf.tidy, which
        // would otherwise dispose the cached table after the first chunk.
        TWIDDLE_CACHE[innerDim] = tf.keep(tf.tensor2d(d, [innerDim + 1, 2]))
    }
    return TWIDDLE_CACHE[innerDim]
}

function windowLUT(frameLength) {
    if (!WINDOW_CACHE[frameLength]) {
        var d = new Float32Array(frameLength)
        for (var i = 0; i < frameLength; i++) {
            d[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frameLength)
        }
        WINDOW_CACHE[frameLength] = tf.keep(tf.tensor1d(d))
    }
    return WINDOW_CACHE[frameLength]
}

tf.registerKernel({
    kernelName: 'STFT',
    backendName: 'webgl',
    kernelFunc: ({ backend, inputs: { signal, frameLength, frameStep } }) => {
        const innerDim = frameLength / 2
        const batch = (signal.size - frameLength + frameStep) / frameStep | 0
        const tw = twiddleLUT(innerDim)
        const win = windowLUT(frameLength)
        let currentTensor = backend.runWebGLProgram({
            variableNames: ['x', 'win'],
            outputShape: [batch, frameLength],
            userCode: `
            void main() {
                ivec2 coords = getOutputCoords();
                int p = coords[1] % ${innerDim};
                int k = 0;
                for (int i = 0; i < ${Math.log2(innerDim)}; ++i) {
                    if ((p & (1 << i)) != 0) { k |= (1 << (${Math.log2(innerDim) - 1} - i)); }
                }
                int i = 2 * k;
                if (coords[1] >= ${innerDim}) {
                    i = 2 * (k % ${innerDim}) + 1;
                }
                int q = coords[0] * ${frameLength} + i;
                float val = getX((q / ${frameLength}) * ${frameStep} + q % ${frameLength});
                float mul = getWin(i);
                setOutput(val * mul);
            }`
        }, [signal, win], 'float32')
        for (let len = 1; len < innerDim; len *= 2) {
            let prevTensor = currentTensor
            currentTensor = backend.runWebGLProgram({
                variableNames: ['x', 'tw'],
                outputShape: [batch, innerDim * 2],
                userCode: `void main() {
                    ivec2 coords = getOutputCoords();
                    int batch = coords[0];
                    int i = coords[1];
                    int k = i % ${innerDim};
                    int isHigh = (k % ${len * 2}) / ${len};
                    int highSign = (1 - isHigh * 2);
                    int baseIndex = k - isHigh * ${len};
                    int j = (k % ${len}) * ${innerDim / len};
                    float a = getTw(j, 0);
                    float b = -getTw(j, 1);
                    float oddK_re = getX(batch, baseIndex + ${len});
                    float oddK_im = getX(batch, baseIndex + ${len + innerDim});
                    if (i < ${innerDim}) { // real
                        float evenK_re = getX(batch, baseIndex);
                        setOutput(evenK_re + (oddK_re * a - oddK_im * b) * float(highSign));
                    } else { // imaginary
                        float evenK_im = getX(batch, baseIndex + ${innerDim});
                        setOutput(evenK_im + (oddK_re * b + oddK_im * a) * float(highSign));
                    }
                }`
            }, [currentTensor, tw], 'float32')
            backend.disposeIntermediateTensorInfo(prevTensor)
        }
        const real = backend.runWebGLProgram({
            variableNames: ['x', 'tw'],
            outputShape: [batch, innerDim + 1],
            userCode: `void main() {
                ivec2 coords = getOutputCoords();
                int batch = coords[0];
                int i = coords[1];
                int zI = i % ${innerDim};
                int conjI = (${innerDim} - i) % ${innerDim};
                float Zk0 = getX(batch, zI);
                float Zk1 = getX(batch, zI+${innerDim});
                float Zk_conj0 = getX(batch, conjI);
                float Zk_conj1 = -getX(batch, conjI+${innerDim});
                // t = -pi*i/innerDim, so cos(t) = tw[i].x and sin(t) = -tw[i].y
                float cosT = getTw(i, 0);
                float sinT = -getTw(i, 1);
                float diff0 = Zk0 - Zk_conj0;
                float diff1 = Zk1 - Zk_conj1;
                float result = (Zk0 + Zk_conj0 + cosT * diff1 + sinT * diff0) * 0.5;
                setOutput(result);
            }`
        }, [currentTensor, tw], 'float32')
        backend.disposeIntermediateTensorInfo(currentTensor)
        return real
    }
})
