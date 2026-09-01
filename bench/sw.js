/* Service worker for the BirdNET bench.
 *
 * Network-first, same as probe/sw.js and for the same reason: a cache-first
 * shell would pin a device in the field to whatever it cached on install,
 * with no way to push a fix. A failed fetch falls back to cache, which is
 * what makes offline work.
 *
 * Scope is /bench/, but scope only limits which PAGES this worker controls —
 * it intercepts every same-origin request those pages make, including the
 * model at ../models/. That is why the weights are mirrored into this repo:
 * cross-origin requests are skipped below, so a remote model could never be
 * cached for field use.
 */

/* Bump ONLY when cached bytes become invalid — never for a code change. The
   name is the identity of a 49 MB download already on the device; renaming it
   silently orphans that and forces the user to fetch it all again. The shell
   is network-first, so shell changes need no bump. */
var CACHE = 'r1-bench-v2';
var SHELL = ['./', './index.html', './birdnet-worker.js', './vendor/tf.min.js',
             './test-audio.json'];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(CACHE)
            .then(function (c) { return c.addAll(SHELL); })
            .then(function () { return self.skipWaiting(); })
            .catch(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys()
            .then(function (names) {
                return Promise.all(names.map(function (n) {
                    /* Only ours, and only superseded ones. */
                    return (n !== CACHE && n.indexOf('r1-bench-') === 0)
                        ? caches.delete(n) : null;
                }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

/* Immutable, large, and never edited in place: model weights, the pinned tfjs
   build, labels, test audio. Network-first on these means re-downloading 49 MB
   on every online launch just to arrive at the bytes already in cache — which
   made being online SLOWER than being offline. Cache-first instead. To replace
   them you change a filename or press SAVE FOR OFFLINE, which refetches with
   cache:'reload'. */
function isImmutable(url) {
    return /\/models\/|\/vendor\/|test-audio\.json$/.test(url);
}

self.addEventListener('fetch', function (e) {
    if (e.request.method !== 'GET') { return; }
    var sameOrigin = false;
    try { sameOrigin = new URL(e.request.url).origin === location.origin; }
    catch (err) { sameOrigin = false; }
    if (!sameOrigin) { return; }

    if (isImmutable(e.request.url)) {
        e.respondWith(
            caches.match(e.request).then(function (hit) {
                if (hit) { return hit; }
                return fetch(e.request).then(function (res) {
                    if (res && res.ok) {
                        var copy = res.clone();
                        caches.open(CACHE).then(function (c) {
                            c.put(e.request, copy).catch(function () {});
                        });
                    }
                    return res;
                });
            })
        );
        return;
    }

    /* The shell is small and mutable. Network-first is what lets a git push
       reach a device in the field; cache-first here would pin it forever. */
    e.respondWith(
        fetch(e.request)
            .then(function (res) {
                if (res && res.ok) {
                    var copy = res.clone();
                    caches.open(CACHE).then(function (c) {
                        c.put(e.request, copy).catch(function () {});
                    });
                }
                return res;
            })
            .catch(function () {
                return caches.match(e.request).then(function (hit) {
                    return hit || caches.match('./index.html');
                });
            })
    );
});

/* Explicit precache of the 49 MB model, driven from the page so the user
   chooses when to spend the bandwidth. Reports progress back to the client. */
self.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'precache-model') { return; }
    var urls = e.data.urls || [];
    var port = e.ports && e.ports[0];
    var done = 0;

    caches.open(CACHE).then(function (c) {
        function next(i) {
            if (i >= urls.length) {
                if (port) { port.postMessage({ done: done, total: urls.length, finished: true }); }
                return;
            }
            fetch(urls[i], { cache: 'reload' })
                .then(function (res) {
                    if (res && res.ok) { return c.put(urls[i], res.clone()); }
                    throw new Error('HTTP ' + (res && res.status));
                })
                .then(function () {
                    done++;
                    if (port) { port.postMessage({ done: done, total: urls.length }); }
                    next(i + 1);
                })
                .catch(function (err) {
                    if (port) {
                        port.postMessage({
                            done: done, total: urls.length,
                            error: urls[i] + ': ' + (err && err.message || err)
                        });
                    }
                    next(i + 1);
                });
        }
        next(0);
    });
});
