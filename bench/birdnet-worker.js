// BirdNET V2.4 inference worker — forked from georg95/birdnet-web (MIT).
//
// Changes from upstream birdnet.js:
//   * model/labels load from absolute GH Pages URLs (upstream hardcodes
//     site-root paths like /birdnet-web/..., which 404 on any other host)
//   * geo/area model, i18n labels and the ?lang= logic removed — upstream
//     crashes on `null.split()` when ?lang= is absent, after warmup and
//     before it posts 'loaded', which hangs the caller with no error
//   * every failure is posted back as {message:'error'} instead of becoming
//     a silent unhandled rejection inside the worker
//   * webgpu STFT kernel dropped (r1 has no WebGPU); webgl kernel verbatim
//   * predict reads `pcmAudio` — upstream's test page sends `audioBuf`,
//     which is the field-name mismatch that hangs it at "Inference..."

importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js')

// Same-origin, mirrored into this repo. Cross-origin worked, but the service
// worker skips cross-origin requests by design, so the model could never be
// cached for field use. Same-origin also drops the third-party dependency.
var BASE = '../models/birdnet/'

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
    // Precision matters as much as speed here: with no float32 render target
    // tfjs silently falls back to f16 textures, and the hand-written FFT
    // accumulates error — same species, lower confidence.
    function flag(name) {
        try { return String(tf.env().get(name)) } catch (e) { return '?' }
    }
    postMessage({
        message: 'backend',
        backend: tf.getBackend(),
        ms: performance.now() - t,
        webglVersion: flag('WEBGL_VERSION'),
        renderF32: flag('WEBGL_RENDER_FLOAT32_ENABLED'),
        forceF16: flag('WEBGL_FORCE_F16_TEXTURES'),
        downloadF32: flag('WEBGL_DOWNLOAD_FLOAT_ENABLED')
    })

    // Storage precision (the flags above) and ALU precision are different
    // axes. getShaderPrecisionFormat reports mantissa bits the fragment
    // shader actually computes with: 23 = fp32, 10 = fp16. And GLSL ES lets
    // mobile GPUs be far looser on cos/sin than desktop — which is where the
    // STFT's per-invocation twiddle factors live, at args up to ~3000 rad.
    var gl = null
    try { gl = tf.backend().gpgpu.gl } catch (e) { gl = null }
    function prec(type) {
        try {
            var p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl[type])
            return p ? p.precision : -1
        } catch (e) { return -1 }
    }
    var renderer = ''
    try {
        var ext = gl.getExtension('WEBGL_debug_renderer_info')
        renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    } catch (e) { renderer = '' }

    // Replicate the kernel's stress case: cos over the same argument range.
    async function cosError(maxArg) {
        var xs = new Float32Array(2048)
        for (var i = 0; i < xs.length; i++) { xs[i] = (i / xs.length) * maxArg }
        var got = await tf.cos(tf.tensor1d(xs)).data()
        var worst = 0
        for (var j = 0; j < xs.length; j++) {
            var e = Math.abs(got[j] - Math.cos(xs[j]))
            if (e > worst) { worst = e }
        }
        return worst
    }
    // MelSpecLayerSimple raises every mel bin to a fractional power:
    // pow(x, 1/(1+exp(1.23))) ~= x^0.226. GLSL pow is exp2(y*log2(x)), and
    // mobile log2/exp2 are much looser than desktop. An error here rescales
    // the whole spectrogram — which moves confidence without moving ranking.
    async function powError() {
        var xs = new Float32Array(2048)
        for (var i = 0; i < xs.length; i++) { xs[i] = 1e-5 + (i / xs.length) * 10 }
        var e = 1 / (1 + Math.exp(1.23))
        var got = await tf.pow(tf.tensor1d(xs), tf.scalar(e)).data()
        var worst = 0
        for (var j = 0; j < xs.length; j++) {
            var want = Math.pow(xs[j], e)
            var rel = Math.abs(got[j] - want) / Math.max(want, 1e-6)
            if (rel > worst) { worst = rel }
        }
        return worst
    }

    // Run the STFT kernel alone on a fixed signal and score it against an
    // exact fp64 DFT computed here in JS. Comparing against truth rather than
    // against another GPU means the bench self-validates on any device — a
    // cross-device checksum can only say "different", not "wrong".
    async function stftCheck() {
        var FL = 1024, FS = 512, n = 4096
        var frames = (n - FL + FS) / FS
        var sig = new Float32Array(n)
        for (var i = 0; i < n; i++) {
            sig[i] = Math.sin(i * 0.01) * 0.5 + Math.sin(i * 0.13) * 0.25
        }
        var out = tf.engine().runKernel('STFT', {
            signal: tf.tensor1d(sig), frameLength: FL, frameStep: FS
        })
        var got = await out.data()
        out.dispose()

        var win = new Float64Array(FL)
        for (var w = 0; w < FL; w++) {
            win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / FL)
        }
        var sum = 0, worst = 0, scale = 0
        for (var f = 0; f < frames; f++) {
            var buf = new Float64Array(FL)
            for (var s = 0; s < FL; s++) { buf[s] = sig[f * FS + s] * win[s] }
            for (var k = 0; k <= FL / 2; k++) {
                var re = 0
                for (var m = 0; m < FL; m++) {
                    re += buf[m] * Math.cos(2 * Math.PI * k * m / FL)
                }
                var g = got[f * (FL / 2 + 1) + k]
                var err = Math.abs(g - re)
                if (err > worst) { worst = err }
                if (Math.abs(re) > scale) { scale = Math.abs(re) }
                sum += Math.abs(g)
            }
        }
        return { sum: sum, relErr: worst / Math.max(scale, 1e-9) }
    }

    var powErr = -1, stft = { sum: -1, relErr: -1 }
    try { powErr = await powError() } catch (e) { powErr = -1 }
    try { stft = await stftCheck() } catch (e) { stft = { sum: -1, relErr: -1 } }

    postMessage({
        message: 'precision',
        renderer: renderer,
        highp: prec('HIGH_FLOAT'),
        mediump: prec('MEDIUM_FLOAT'),
        cosErrSmall: await cosError(6.283185307179586),
        cosErrLarge: await cosError(3000),
        powErr: powErr,
        stft: stft.sum,
        stftRelErr: stft.relErr
    })

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

    onmessage = function (ev) {
        run(ev.data).catch(function (e) { fail('predict', e) })
    }
    postMessage({ message: 'ready' })

    async function run(data) {
        if (data.message !== 'bench') return
        var pcm = data.pcmAudio
        var runs = data.runs || 5
        var times = []
        var last = null
        for (var i = 0; i < runs; i++) {
            var s = performance.now()
            last = await predict(tf.tensor(pcm, [pcm.length / 144000, 144000]))
            var ms = performance.now() - s
            times.push(ms)
            postMessage({ message: 'run', index: i + 1, of: runs, ms: ms })
        }
        var top = []
        for (var b = 0; b < last.length; b++) {
            for (var j = 0; j < last[b].length; j++) {
                if (last[b][j] > 0.1) {
                    top.push({ name: (labels[j] || '_').split('_')[1], confidence: last[b][j] })
                }
            }
        }
        top.sort(function (a, b) { return b.confidence - a.confidence })
        var sorted = times.slice().sort(function (a, b) { return a - b })
        postMessage({
            message: 'done',
            times: times,
            min: sorted[0],
            median: sorted[(sorted.length / 2) | 0],
            max: sorted[sorted.length - 1],
            top: top.slice(0, 5)
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
