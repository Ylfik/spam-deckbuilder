// Lecture de texte à l'écran (tour, chance, Tox de la boutique) avec Tesseract, entièrement hors ligne.
const path = require('path');
const { PNG } = require('pngjs');
const V = require('./vision.js');
let T = null, fra = null, num = null, ready = null;
// dans l'application empaquetée, les modules d'OCR sont hors de l'archive asar
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
function langDir(lang) { return unpacked(path.dirname(require.resolve(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`))); }
async function init(cacheDir) {
  if (ready) return ready;
  ready = (async () => {
    T = require('tesseract.js');
    // sous Electron, Tesseract voudrait télécharger les langues : on les dépose dans son cache, qu'il lit en premier
    const fs = require('fs'); fs.mkdirSync(cacheDir, { recursive: true });
    for (const lang of ['fra', 'eng']) { const dst = path.join(cacheDir, lang + '.traineddata'); if (!fs.existsSync(dst)) fs.copyFileSync(path.join(langDir(lang), lang + '.traineddata.gz'), dst); }
    const opt = () => ({ langPath: cacheDir, gzip: true, cachePath: cacheDir, cacheMethod: 'readOnly', workerPath: unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js')) });
    fra = await T.createWorker('fra', 1, opt('fra'));
    await fra.setParameters({ tessedit_pageseg_mode: '6' });
    num = await T.createWorker('eng', 1, opt('eng'));
    await num.setParameters({ tessedit_char_whitelist: '0123456789/TOUR ', tessedit_pageseg_mode: '7' });
  })();
  return ready;
}
const png = (c) => { const p = new PNG({ width: c.w, height: c.h }); c.data.copy(p.data); return PNG.sync.write(p); };
async function read(worker, img, box, scale, thr, dark) { const r = await worker.recognize(png(V.cropForOcr(img, box, scale, thr, dark))); return r.data.text.replace(/\s+/g, ' ').trim(); }
const int = (s) => { const m = String(s).match(/\d+/); return m ? +m[0] : null; };

async function readBoard(img) {
  const turn = int(await read(num, img, V.OCR_BOXES.turn, 3, 150));
  const luck = int(await read(num, img, V.OCR_BOXES.luck, 4, 170));
  const gold = int(await read(num, img, V.OCR_BOXES.gold, 4, 170));
  return { turn, luck, gold };
}
// la boutique : 3 offres (nom, description, prix), relance, or, tour. Plusieurs seuils sont essayés
// (les cadres rares/légendaires sont plus clairs et décalés) ; on garde la lecture qui ressemble le plus à un Tox connu.
async function readShop(img, pool) {
  const offers = [];
  for (let k = 0; k < 3; k++) {
    const cx = [510, 960, 1410][k];
    const names = [];
    for (const [box, thr] of [[V.OCR_BOXES.shopNames[k], 200], [[cx - 150, 330, cx + 150, 372], 180], [[cx - 150, 365, cx + 150, 410], 180]]) {
      const t = await read(fra, img, box, 2, thr); if (t) names.push(t);
    }
    const descs = [];
    for (const thr of [195, 150]) { const t = await read(fra, img, V.OCR_BOXES.shopDesc[k], 2, thr); if (t) descs.push(t); }
    let best = { name: names[0] || '', desc: descs[0] || '', m: null };
    for (const n of names.length ? names : ['']) for (const d of descs.length ? descs : ['']) {
      const m = pool ? matchTox({ name: n, desc: d }, pool) : null;
      if (m && (!best.m || m.s > best.m.s)) best = { name: n, desc: d, m };
    }
    let price = int(await read(num, img, V.OCR_BOXES.shopPrice[k], 3, 110, true));
    if (price === 1) price = 10; // le « 0 » du badge est souvent mal lu
    offers.push({ name: best.name, desc: best.desc, price, tox: best.m ? { id: best.m.id, n: best.m.n, r: best.m.r, e: best.m.e } : null });
  }
  const reroll = int(await read(num, img, V.OCR_BOXES.reroll, 3, 110, true));
  const gold = int(await read(num, img, V.OCR_BOXES.gold, 4, 170));
  const turn = int(await read(num, img, V.OCR_BOXES.turn, 3, 150));
  return { offers, reroll, gold, turn };
}

// rapprochement du texte lu avec les Tox connus (nom + description, pour départager les raretés)
const clean = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/Œ/g, 'OE').replace(/[^A-Z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const sim = (a, b) => { a = clean(a); b = clean(b); if (!a || !b) return 0; return 1 - lev(a, b) / Math.max(a.length, b.length); };
function matchTox(offer, pool) {
  let best = null;
  for (const t of pool) {
    const ns = Math.max(sim(offer.name, t.n), sim(String(offer.name).replace(/F/g, 'P'), t.n)); // la police confond P et F
    const s = 0.65 * ns + 0.35 * sim(offer.desc, t.e);
    if (!best || s > best.s) best = { ...t, s, nameSim: ns };
  }
  return best && (best.nameSim >= 0.6 || best.s >= 0.55) ? best : null;
}
// nom d'une carte sur le plateau : plusieurs seuils, on garde la lecture la plus proche d'un nom connu
async function readCardName(img, box, names) {
  let best = null;
  for (const [thr, dark] of [[200, false], [170, false], [90, true]]) {
    const prev = fra && (await fra.setParameters({ tessedit_pageseg_mode: '7' }));
    const t = await read(fra, img, box, 4, thr, dark);
    for (const [id, n] of names) { const s = sim(t, n); if (!best || s > best.s) best = { id, s, text: t }; }
    if (best && best.s >= 0.85) break;
  }
  await fra.setParameters({ tessedit_pageseg_mode: '6' });
  return best && best.s >= 0.7 ? best : null;
}
// mes cartes montrent leurs compétences en gros : on reconnaît la carte à ses 2 noms de compétence
async function readAbilities(img, x, yTop, cards) {
  await fra.setParameters({ tessedit_pageseg_mode: '7' });
  const lines = [];
  for (const dy of [186, 221]) for (const thr of [170, 140]) { const t = await read(fra, img, [x + 45, yTop + dy, x + 185, yTop + dy + 17], 4, thr); if (t) lines.push(t); }
  await fra.setParameters({ tessedit_pageseg_mode: '6' });
  let best = null;
  for (const c of cards) {
    const ab = c.ab.map((a) => a.n); if (!ab.length) continue;
    const sc = ab.map((n) => Math.max(0, ...lines.map((l) => sim(l, n)))); const v = sc.reduce((a, b) => a + b, 0) / sc.length;
    if (!best || v > best.s) best = { id: c.id, s: v };
  }
  return best && best.s >= 0.72 ? best : null;
}
async function close() { if (fra) await fra.terminate(); if (num) await num.terminate(); fra = num = ready = null; }
module.exports = { init, readBoard, readShop, readCardName, readAbilities, matchTox, clean, sim, close };
