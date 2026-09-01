// Usage: node make-qr.js <outfile.svg> <title> <url> [description] [themeColor]
// Emits a standalone SVG QR encoding an r1 creation install payload.
var fs = require("fs");
var qrcode = require("./qrcode.js");

var out         = process.argv[2];
var title       = process.argv[3];
var url         = process.argv[4];
var description = process.argv[5] || "";
var themeColor  = process.argv[6] || "#F59E0B";

if (!out || !title || !url) {
  console.error("usage: node make-qr.js <out.svg> <title> <url> [description] [themeColor]");
  process.exit(1);
}

var payload = { title: title, url: url, description: description, iconUrl: "", themeColor: themeColor };
var json = JSON.stringify(payload);

var qr = qrcode(0, "M");          // 0 = auto-size, M = ~15% error correction
qr.addData(json);
qr.make();

var n = qr.getModuleCount(), cell = 10, margin = 4;
var size = (n + margin * 2) * cell;

// Label band. Bare codes are indistinguishable from each other — several of
// these live side by side and differ only in module pattern, which is exactly
// how you end up scanning the wrong one. The title is printed underneath.
var labelH = 64;
var total = size + labelH;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

var svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + total +
           '" viewBox="0 0 ' + size + ' ' + total + '">',
           '<rect width="' + size + '" height="' + total + '" fill="#ffffff"/>'];
for (var r = 0; r < n; r++) {
  for (var c = 0; c < n; c++) {
    if (qr.isDark(r, c)) {
      svg.push('<rect x="' + ((c + margin) * cell) + '" y="' + ((r + margin) * cell) +
               '" width="' + cell + '" height="' + cell + '" fill="#000000"/>');
    }
  }
}
svg.push('<text x="' + (size / 2) + '" y="' + (size + 30) +
         '" text-anchor="middle" font-family="monospace" font-size="30" ' +
         'font-weight="bold" fill="#000000">' + esc(title) + "</text>");
// Last path segment disambiguates /app/ from /bench/ from /probe/ at a glance.
var tail = String(url).replace(/\/$/, "").split("/").slice(-1)[0];
svg.push('<text x="' + (size / 2) + '" y="' + (size + 52) +
         '" text-anchor="middle" font-family="monospace" font-size="20" ' +
         'fill="#666666">/' + esc(tail) + "/</text>");
svg.push("</svg>");

fs.writeFileSync(out, svg.join(""));
console.log("wrote " + out + "  " + size + "x" + total + "px  modules=" + n +
            "  payload=" + json.length + " bytes  label=" + title + " /" + tail + "/");
console.log(json);
