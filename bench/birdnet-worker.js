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

var BASE = 'https://georg95.github.io/birdnet-web/models/birdnet/'

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

tf.registerKernel({
    kernelName: 'STFT',
    backendName: 'webgl',
    kernelFunc: ({ backend, inputs: { signal, frameLength, frameStep } }) => {
        const innerDim = frameLength / 2
        const batch = (signal.size - frameLength + frameStep) / frameStep | 0
        let currentTensor = backend.runWebGLProgram({
            variableNames: ['x'],
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
                float cosArg = ${2.0 * Math.PI / frameLength} * float(q);
                float mul = 0.5 - 0.5 * cos(cosArg);
                setOutput(val * mul);
            }`
        }, [signal], 'float32')
        for (let len = 1; len < innerDim; len *= 2) {
            let prevTensor = currentTensor
            currentTensor = backend.runWebGLProgram({
                variableNames: ['x'],
                outputShape: [batch, innerDim * 2],
                userCode: `void main() {
                    ivec2 coords = getOutputCoords();
                    int batch = coords[0];
                    int i = coords[1];
                    int k = i % ${innerDim};
                    int isHigh = (k % ${len * 2}) / ${len};
                    int highSign = (1 - isHigh * 2);
                    int baseIndex = k - isHigh * ${len};
                    float t = ${Math.PI / len} * float(k % ${len});
                    float a = cos(t);
                    float b = sin(-t);
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
            }, [currentTensor], 'float32')
            backend.disposeIntermediateTensorInfo(prevTensor)
        }
        const real = backend.runWebGLProgram({
            variableNames: ['x'],
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
                float t = ${-2 * Math.PI} * float(i) / float(${innerDim * 2});
                float diff0 = Zk0 - Zk_conj0;
                float diff1 = Zk1 - Zk_conj1;
                float result = (Zk0 + Zk_conj0 + cos(t) * diff1 + sin(t) * diff0) * 0.5;
                setOutput(result);
            }`
        }, [currentTensor], 'float32')
        backend.disposeIntermediateTensorInfo(currentTensor)
        return real
    }
})
