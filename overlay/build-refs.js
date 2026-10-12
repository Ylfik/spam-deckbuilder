// Prépare les empreintes des illustrations (vision/refs.json) et du titre de la boutique, à partir d'images brutes.
// Utilisation : node build-refs.js refs.raw shop.png
const fs = require('fs'); const { PNG } = require('pngjs');
const V = require('./src/vision.js');
const raw = fs.readFileSync(process.argv[2]); let o = 0; const refs = {};
while (o < raw.length) {
  const nl = raw.readUInt16LE(o), w = raw.readUInt16LE(o + 2), h = raw.readUInt16LE(o + 4); o += 6;
  const id = raw.slice(o, o + nl).toString(); o += nl;
  const data = raw.slice(o, o + w * h * 4); o += w * h * 4;
  refs[id] = Array.from(V.refFeature({ w, h, data, bgra: false }), (v) => Math.round(v * 1000));
}
const shop = PNG.sync.read(fs.readFileSync(process.argv[3]));
const shopRef = Array.from(V.featRegion({ w: shop.width, h: shop.height, data: shop.data, bgra: false }, 740, 105, 1180, 175, 32, 6), (v) => Math.round(v * 1000));
fs.writeFileSync(__dirname + '/vision/refs.json', JSON.stringify({ cfg: V.CFG, refs, shopRef }));
console.log('empreintes', Object.keys(refs).length);
