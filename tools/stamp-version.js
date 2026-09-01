// Write app/data/version.json from the current build id and HEAD commit.
//
// Run this immediately BEFORE committing. The point is not to detect a stale
// page — the build stamp in index.html already does that — but to detect a
// deploy that never published at all. When a Pages build fails, index.html and
// version.json are both old and agree with each other, so the device sees
// nothing wrong. Comparing against the repo's HEAD on the GitHub API catches
// it, because the repo advances even when the publish does not.
//
// Usage:  node tools/stamp-version.js
//         git add -A && git commit ...

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var root = path.dirname(__dirname);
var html = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
var m = html.match(/name="build" content="([^"]+)"/);
if (!m) {
  console.error("no build meta found in app/index.html");
  process.exit(1);
}

function git(args) {
  return cp.execSync("git " + args, { cwd: root }).toString().trim();
}

// HEAD is the commit this stamp will be committed ON TOP of, so the published
// site is always one commit behind what the API will report. The app allows
// for that by comparing timestamps with a tolerance rather than SHAs.
var out = {
  build: m[1],
  base: git("rev-parse --short HEAD"),
  at: new Date().toISOString(),
  repo: "SebbyTeaDev/R1-Pokedex"
};

var dst = path.join(root, "app", "data", "version.json");
fs.writeFileSync(dst, JSON.stringify(out), "utf8");
console.log("stamped " + out.build + " base=" + out.base + " at=" + out.at);
