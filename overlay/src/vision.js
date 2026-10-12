// Lecture de l'écran du jeu (1920×1080, ou toute résolution 16:9 ramenée à 1920×1080).
// Tout est calculé ici, sans réseau : reconnaissance des cartes par leur illustration, PV par la longueur de la barre,
// détection de la boutique par son titre. Les zones de texte (tour, Tox) sont découpées pour l'OCR (src/ocr.js).
// img = { w, h, data, bgra } : pixels bruts (BGRA pour Electron sous Windows, RGBA pour les tests).
const CFG = {
  XS: [308, 575, 843, 1110], // bord gauche des 4 emplacements de carte
  ART_W: 225, Y_ME: 558, Y_OPP: 201, F0: 0.16, F1: 0.46, // zone d'illustration comparée (fractions de l'illustration)
  THR: 0.93, MARGIN: 0.06, // score minimal et écart minimal avec la 2e carte pour valider
  BAR: { me: 848, opp: 492, x0: 16, x1: 208 }, // barre de PV (ligne et bornes relatives à la carte)
  FW: 24, FH: 16,
};
const ART_H = CFG.ART_W * 512 / 358;

function px(img, x, y) {
  const sx = img.w / 1920, sy = img.h / 1080;
  const X = Math.min(img.w - 1, Math.max(0, Math.round(x * sx))), Y = Math.min(img.h - 1, Math.max(0, Math.round(y * sy)));
  const i = (Y * img.w + X) * 4; const d = img.data;
  return img.bgra ? [d[i + 2], d[i + 1], d[i]] : [d[i], d[i + 1], d[i + 2]];
}
// moyenne par zones (x0..x1, y0..y1 en coordonnées 1920×1080) -> vecteur normalisé (RGB + 2 × gris)
function featRegion(img, x0, y0, x1, y1, fw = CFG.FW, fh = CFG.FH, scaleToImg = true) {
  const sx = scaleToImg ? img.w / 1920 : 1, sy = scaleToImg ? img.h / 1080 : 1;
  const X0 = x0 * sx, Y0 = y0 * sy, X1 = x1 * sx, Y1 = y1 * sy; const d = img.data; const out = new Float32Array(fw * fh * 4);
  for (let cy = 0; cy < fh; cy++) for (let cx = 0; cx < fw; cx++) {
    const ax = Math.floor(X0 + (X1 - X0) * cx / fw), bx = Math.max(ax + 1, Math.floor(X0 + (X1 - X0) * (cx + 1) / fw));
    const ay = Math.floor(Y0 + (Y1 - Y0) * cy / fh), by = Math.max(ay + 1, Math.floor(Y0 + (Y1 - Y0) * (cy + 1) / fh));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
      const i = (Math.min(img.h - 1, y) * img.w + Math.min(img.w - 1, x)) * 4;
      if (img.bgra) { b += d[i]; g += d[i + 1]; r += d[i + 2]; } else { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      n++;
    }
    const k = (cy * fw + cx) * 4; r /= n; g /= n; b /= n;
    out[k] = r; out[k + 1] = g; out[k + 2] = b; out[k + 3] = 2 * (r + g + b) / 3;
  }
  let m = 0; for (const v of out) m += v; m /= out.length;
  let s = 0; for (let i = 0; i < out.length; i++) { out[i] -= m; s += out[i] * out[i]; }
  s = Math.sqrt(s) || 1; for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}
// même découpe sur une illustration de référence (358×512)
function refFeature(img) { return featRegion(img, 0.08 * img.w, CFG.F0 * img.h, 0.92 * img.w, CFG.F1 * img.h, CFG.FW, CFG.FH, false); }
function slotFeature(img, x, ytop) {
  return featRegion(img, x + 1 + 0.08 * CFG.ART_W, ytop + CFG.F0 * ART_H, x + 1 + 0.92 * CFG.ART_W, ytop + CFG.F1 * ART_H);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function matchSlot(q, refs) {
  let b1 = -2, b2 = -2, id = null;
  for (const [k, v] of refs) { const s = dot(q, v); if (s > b1) { b2 = b1; b1 = s; id = k; } else if (s > b2) b2 = s; }
  return { id: b1 >= CFG.THR && b1 - b2 >= CFG.MARGIN ? id : null, best: id, score: b1, margin: b1 - b2 };
}
// part de PV restante : on suit la partie colorée de la barre depuis la gauche ; le texte blanc des PV est ignoré,
// la barre s'arrête au premier passage sombre (partie vide) ; les icônes posées après (poison…) ne comptent pas
function hpFraction(img, x, row) {
  const y = CFG.BAR[row] + 5; let last = -1, dark = 0, seen = 0;
  for (let dx = CFG.BAR.x0 - 4; dx <= CFG.BAR.x1; dx++) {
    const [r, g, b] = px(img, x + dx, y); const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn > 70 && mx > 140) { last = dx; seen++; dark = 0; }
    else if (mx < 120 && r - b > 25) { if (seen && ++dark >= 4) break; } // fond brun de la barre vide (le contour gris du texte ne compte pas)
  }
  if (seen < 3) return 0;
  return Math.max(0, Math.min(1, (last - CFG.BAR.x0) / (CFG.BAR.x1 - CFG.BAR.x0)));
}
// analyse d'une image : scène, cartes reconnues, PV
function analyseFrame(img, refs, shopRef) {
  const out = { scene: 'other', me: [], opp: [] };
  if (shopRef && dot(featRegion(img, 740, 105, 1180, 175, 32, 6), shopRef) > 0.85) { out.scene = 'shop'; return out; }
  let seen = 0, bars = 0;
  for (const [row, yt] of [['me', CFG.Y_ME], ['opp', CFG.Y_OPP]]) for (const x of CFG.XS) {
    const m = matchSlot(slotFeature(img, x, yt), refs); const hp = hpFraction(img, x, row);
    if (m.id) seen++; if (hp > 0) bars++;
    out[row].push({ ...m, hp: m.id || hp > 0 ? hp : null });
  }
  // plateau : au moins 2 cartes reconnues, ou des barres de PV à au moins 4 emplacements (illustrations inconnues)
  if (seen >= 2 || bars >= 4) out.scene = 'board';
  return out;
}

// zones à lire à l'OCR (coordonnées 1920×1080)
const OCR_BOXES = {
  turn: [1720, 555, 1860, 600],
  luck: [305, 1020, 345, 1062],
  gold: [290, 950, 352, 992],
  reroll: [130, 515, 240, 575],
  shopNames: [510, 960, 1410].map((cx) => [cx - 150, 320, cx + 150, 410]),
  shopDesc: [510, 960, 1410].map((cx) => [cx - 175, 595, cx + 175, 765]),
  shopPrice: [700, 1150, 1600].map((cx) => [cx - 32, 272, cx + 32, 328]),
};
// découpe + agrandissement + seuil (texte clair -> noir sur blanc), en RGBA pour l'OCR
function cropForOcr(img, box, scale = 3, thr = 200, dark = false) { // dark : texte foncé sur fond clair (prix)
  const [x0, y0, x1, y1] = box; const W = Math.round((x1 - x0) * scale), H = Math.round((y1 - y0) * scale);
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(img, x0 + x / scale, y0 + y / scale); const L = (r + g + b) / 3; const v = (dark ? L < thr : L > thr) ? 0 : 255;
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { w: W, h: H, data };
}
// bandeau du nom en haut de la carte (lisible quelle que soit l'illustration : full art, alternative…)
const nameBox = (row, x) => { const yt = row === 'me' ? CFG.Y_ME - 1 : CFG.Y_OPP - 1; return [x + 30, yt + 10, x + 197, yt + 27]; };
module.exports = { nameBox, CFG, featRegion, refFeature, slotFeature, matchSlot, hpFraction, analyseFrame, OCR_BOXES, cropForOcr, dot };
