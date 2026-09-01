#!/usr/bin/env python3
"""Harvest one thumbnail per BirdNET species from Wikimedia, for offline bundling.

Three phases, each resumable — rerunning skips work already on disk:

  meta   batched Wikipedia pageimages lookups, scientific name -> thumb URL
  fetch  download each thumb at a polite rate
  pack   crop to square, resize, encode WebP, emit one blob + offset index

Why Wikimedia and not the obvious alternatives:
  * BirdNET's own taxonomy API is 24% Macaulay Library, all rights reserved,
    and their terms forbid third-party download. Fine to hotlink, not to bundle.
  * iNaturalist is only ~15% as freely licensed as Commons, and 9% is ND,
    which forbids the cropping this does.
  Commons measured zero NC and zero ND across 6468 files.

Licensing: ~93% require attribution. attribution.json is emitted alongside and
MUST be shipped and shown. CC BY-SA does not infect the app — resizing is a
technical modification, not an Adaptation, and displaying images next to our
own content is a Collection.

Usage:  python tools/harvest-images.py meta|fetch|pack|all
"""

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABELS = os.path.join(ROOT, "models", "birdnet", "labels", "en_us.txt")
WORK = os.path.join(ROOT, ".harvest")           # intermediates, git-ignored
OUT = os.path.join(ROOT, "app", "data")

API = "https://en.wikipedia.org/w/api.php"
# Wikimedia requires a real, contactable User-Agent. Without one the CDN 403s.
UA = "R1-Pokedex/1.0 (https://github.com/SebbyTeaDev/R1-Pokedex; personal project)"

THUMB_PX = 250      # server-side buckets are fixed: 60,120,250,330,500. 240 -> HTTP 400.
OUT_PX = 80         # final square, measured at ~1541 B WebP q70
QUALITY = 70
API_DELAY = 0.5     # documented ceiling is 200 req/min; this is well under
IMG_DELAY = 1.0     # the image CDN 429s at 2 req/s, is clean at 1

# Not species — the model's way of saying "that was not an animal".
NON_SPECIES = {
    "Dog", "Engine", "Environmental", "Fireworks", "Gun",
    "Human non-vocal", "Human vocal", "Human whistle",
    "Noise", "Power tools", "Siren",
}


def log(*a):
    print(*a, flush=True)


def get(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read()
        except Exception as e:
            code = getattr(e, "code", None)
            if attempt == tries - 1:
                raise
            # 429 means we are going too fast; back off hard rather than hammer.
            wait = 10 * (attempt + 1) if code == 429 else 2 * (attempt + 1)
            log(f"    retry {attempt+1}/{tries-1} after {wait}s ({code or e})")
            time.sleep(wait)


def api(params):
    params = dict(params)
    params.update({"action": "query", "format": "json", "formatversion": "2"})
    return json.loads(get(API + "?" + urllib.parse.urlencode(params)))


def species():
    """Return [(scientific, common)] for the 6511 real species."""
    out = []
    with io.open(LABELS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            sci, _, common = line.partition("_")
            if sci in NON_SPECIES:
                continue
            out.append((sci, common or sci))
    return out


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- meta

def phase_meta():
    os.makedirs(WORK, exist_ok=True)
    path = os.path.join(WORK, "meta.json")
    found = {}
    if os.path.exists(path):
        found = json.load(io.open(path, encoding="utf-8"))
        log(f"resuming with {len(found)} already resolved")

    sp = species()
    log(f"{len(sp)} species")

    def lookup(titles, key_for):
        """titles -> {resolved_title: {thumb, file}}; follows redirects."""
        res = api({
            "prop": "pageimages",
            "piprop": "thumbnail|name",
            "pithumbsize": str(THUMB_PX),
            "pilicense": "free",
            "redirects": "1",
            "titles": "|".join(titles),
        })
        q = res.get("query", {})
        # Map each resolved title back to EVERY title we asked for that led to
        # it. Several species legitimately share one article — Acanthis flammea
        # and its relatives all redirect to "Redpoll". Keying this dict by
        # destination title silently dropped all but one of them, which is why
        # a bird as common as the Common Redpoll first came back imageless.
        alias = {}
        for r in q.get("redirects", []):
            alias.setdefault(r["to"], []).append(r["from"])
        for n in q.get("normalized", []):
            alias.setdefault(n["to"], []).append(n["from"])
        # Normalisation can chain into a redirect, so resolve one more hop.
        for dest, srcs in list(alias.items()):
            for s in list(srcs):
                if s in alias:
                    alias[dest].extend(alias[s])
        got = {}
        for page in q.get("pages", []):
            title = page.get("title", "")
            thumb = page.get("thumbnail", {}).get("source")
            if not thumb:
                continue
            entry = {"thumb": thumb, "file": page.get("pageimage", "")}
            for asked in alias.get(title, []) + [title]:
                got[asked] = entry
        return got

    # Pass 1: scientific names.
    todo = [(s, c) for s, c in sp if s not in found]
    for i, batch in enumerate(chunks(todo, 50)):
        got = lookup([s for s, _ in batch], None)
        for sci, common in batch:
            if sci in got:
                found[sci] = dict(got[sci], via="sci", common=common)
        if i % 20 == 0:
            log(f"  sci batch {i}: {len(found)} resolved")
            json.dump(found, io.open(path, "w", encoding="utf-8"))
        time.sleep(API_DELAY)
    json.dump(found, io.open(path, "w", encoding="utf-8"))
    log(f"after scientific-name pass: {len(found)}/{len(sp)}")

    # Pass 2: common names for whatever is still missing.
    missing = [(s, c) for s, c in sp if s not in found]
    log(f"trying common-name fallback for {len(missing)}")
    for batch in chunks(missing, 50):
        got = lookup([c for _, c in batch], None)
        for sci, common in batch:
            if common in got:
                found[sci] = dict(got[common], via="common", common=common)
        time.sleep(API_DELAY)
    json.dump(found, io.open(path, "w", encoding="utf-8"))

    still = [s for s, _ in sp if s not in found]
    log(f"RESOLVED {len(found)}/{len(sp)} ({100.0*len(found)/len(sp):.2f}%)")
    log(f"no image for {len(still)}: {still[:20]}")
    json.dump(still, io.open(os.path.join(WORK, "missing.json"), "w", encoding="utf-8"))


# ---------------------------------------------------------------- attribution

def phase_attrib():
    meta = json.load(io.open(os.path.join(WORK, "meta.json"), encoding="utf-8"))
    path = os.path.join(WORK, "attrib.json")
    attrib = json.load(io.open(path, encoding="utf-8")) if os.path.exists(path) else {}

    files = sorted({m["file"] for m in meta.values() if m.get("file")})
    todo = [f for f in files if f not in attrib]
    log(f"{len(files)} unique files, {len(todo)} need attribution")

    import re
    tag = re.compile(r"<[^>]+>")

    for i, batch in enumerate(chunks(todo, 50)):
        res = api({
            "prop": "imageinfo",
            "iiprop": "extmetadata|url",
            "iiextmetadatafilter": "Artist|LicenseShortName|Credit",
            "titles": "|".join("File:" + f for f in batch),
        })
        for page in res.get("query", {}).get("pages", []):
            ii = (page.get("imageinfo") or [{}])[0]
            ex = ii.get("extmetadata", {})
            name = page.get("title", "")[5:]        # strip "File:"
            artist = tag.sub("", ex.get("Artist", {}).get("value", "")).strip()
            # Commons fills this in when uploads lack machine-readable authorship.
            if "No machine-readable author" in artist:
                artist = "Unknown"
            attrib[name] = {
                "by": " ".join(artist.split())[:80],
                "lic": ex.get("LicenseShortName", {}).get("value", "").strip(),
                "url": ii.get("descriptionurl", ""),
            }
        if i % 20 == 0:
            log(f"  attrib batch {i}: {len(attrib)}")
            json.dump(attrib, io.open(path, "w", encoding="utf-8"))
        time.sleep(API_DELAY)

    json.dump(attrib, io.open(path, "w", encoding="utf-8"))
    lic = {}
    for a in attrib.values():
        lic[a["lic"]] = lic.get(a["lic"], 0) + 1
    log("licenses: " + ", ".join(f"{k or '?'}={v}" for k, v in
                                 sorted(lic.items(), key=lambda x: -x[1])[:12]))


# ---------------------------------------------------------------- fetch

def phase_fetch():
    meta = json.load(io.open(os.path.join(WORK, "meta.json"), encoding="utf-8"))
    raw = os.path.join(WORK, "raw")
    os.makedirs(raw, exist_ok=True)

    items = sorted(meta.items())
    todo = [(s, m) for s, m in items
            if not os.path.exists(os.path.join(raw, s.replace("/", "_") + ".bin"))]
    log(f"{len(items)} images, {len(todo)} to fetch, ~{len(todo)*IMG_DELAY/60:.0f} min")

    fails = []
    for i, (sci, m) in enumerate(todo):
        try:
            data = get(m["thumb"])
            with open(os.path.join(raw, sci.replace("/", "_") + ".bin"), "wb") as fh:
                fh.write(data)
        except Exception as e:
            fails.append((sci, str(e)[:80]))
        if i % 200 == 0:
            log(f"  {i}/{len(todo)}  fails={len(fails)}")
        time.sleep(IMG_DELAY)

    log(f"fetch done, {len(fails)} failures")
    json.dump(fails, io.open(os.path.join(WORK, "fetch-fails.json"), "w", encoding="utf-8"))


# ---------------------------------------------------------------- pack

def phase_pack():
    from PIL import Image

    meta = json.load(io.open(os.path.join(WORK, "meta.json"), encoding="utf-8"))
    attrib_path = os.path.join(WORK, "attrib.json")
    attrib = json.load(io.open(attrib_path, encoding="utf-8")) if os.path.exists(attrib_path) else {}
    raw = os.path.join(WORK, "raw")
    os.makedirs(OUT, exist_ok=True)

    sp = species()
    order = [s for s, _ in sp]                    # label order == model output order
    index, blob, bad = {}, bytearray(), []

    for sci in order:
        p = os.path.join(raw, sci.replace("/", "_") + ".bin")
        if not os.path.exists(p):
            continue
        try:
            im = Image.open(p).convert("RGB")
            # Cover-crop to square from the centre, then downscale.
            w, h = im.size
            side = min(w, h)
            im = im.crop(((w - side) // 2, (h - side) // 2,
                          (w - side) // 2 + side, (h - side) // 2 + side))
            im = im.resize((OUT_PX, OUT_PX), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=QUALITY, method=6)
            b = buf.getvalue()
        except Exception as e:
            bad.append((sci, str(e)[:60]))
            continue
        index[sci] = [len(blob), len(b)]          # [offset, length]
        blob += b

    # One blob, not 6511 files: on a 4KB-block filesystem individual files cost
    # ~166% overhead (10MB of images occupying ~27MB on the device).
    with open(os.path.join(OUT, "birds.webpack"), "wb") as fh:
        fh.write(bytes(blob))
    json.dump(index, io.open(os.path.join(OUT, "birds.idx.json"), "w", encoding="utf-8"),
              separators=(",", ":"), sort_keys=True)

    used = {}
    for sci in index:
        f = meta.get(sci, {}).get("file", "")
        if f in attrib:
            used[sci] = attrib[f]
    json.dump(used, io.open(os.path.join(OUT, "attribution.json"), "w", encoding="utf-8"),
              separators=(",", ":"), sort_keys=True)

    log(f"packed {len(index)} images, blob {len(blob)/1048576:.2f} MB, "
        f"mean {len(blob)//max(1,len(index))} B")
    log(f"failed to encode: {len(bad)} {bad[:5]}")


if __name__ == "__main__":
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    if phase in ("meta", "all"):
        phase_meta()
    if phase in ("attrib", "all"):
        phase_attrib()
    if phase in ("fetch", "all"):
        phase_fetch()
    if phase in ("pack", "all"):
        phase_pack()
