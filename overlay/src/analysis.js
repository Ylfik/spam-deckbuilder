// Analyse d'un plateau : chances de victoire et ordre des cibles, avec le moteur de l'Atelier SPAM.
// Tourne dans un thread à part (worker_threads) pour ne jamais figer l'overlay.
const path = require('path');
const fs = require('fs');
const CORE = path.join(__dirname, '..', 'core');
require(path.join(CORE, 'engine.js'));
require(path.join(CORE, 'duel.js'));
const Dl = globalThis.SpamDuel;
const D = JSON.parse(fs.readFileSync(path.join(CORE, 'cards.json'), 'utf8'));
globalThis.__SPAM_CARDS = D.cards;
const byId = Object.fromEntries(D.cards.map((c) => [c.id, c]));
const ELS = ['fire', 'water', 'earth', 'nature', 'light', 'shadow'];

const deckOf = (spec) => spec.filter((x) => byId[x.id]).map((x) => ({ card: byId[x.id], talent: x.t || 0, tox: x.tox || [] }));

// éléments de mes dégâts (pondérés) -> PV effectifs d'une carte adverse face à moi
function myDamageMix(mine) {
  const w = Object.fromEntries(ELS.map((e) => [e, 0]));
  for (const { card } of mine) for (const ab of card.ab) for (const a of ab.ac) if (a[0] === 'damage') w[a[4] || card.el] += (a[2] + a[3]) / 2 / Math.max(1, ab.cd || 1);
  const s = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(ELS.map((e) => [e, w[e] / s]));
}
function effHp(card, mix) {
  const r = ELS.reduce((x, e) => x + mix[e] * Math.min(50, card.res[e] || 0), 0);
  return card.hp / Math.max(0.5, 1 - r / 100);
}

function series(A, B, n, opts = {}) {
  const impA = Dl.impacts(A), impB = Dl.impacts(B);
  let w = 0, turns = 0, wins = 0, m = 0;
  for (let q = 0; q < n; q++) {
    const r = Dl.duel(A, B, { aFirst: q % 2 === 0, impA, impB, seed: 4242 + q * 7919, shop: true, ...opts });
    const pt = r.winner === 'A' ? 1 : r.winner === 'nul' ? 0.5 : 0;
    if (r.winner === 'A') { wins++; turns += r.turns; }
    w += pt;
    // marge continue (utile quand un camp gagne presque toujours) : victoire + écart de PV restants
    m += 2 * pt - 1 + (r.hpA - r.hpB);
  }
  return { wr: w / n, turns: wins ? turns / wins : null, margin: m / n };
}

// mine, opp : [{id, t}] ; n : parties par mesure
function analyse(mineSpec, oppSpec, n = 160) {
  const mine = deckOf(mineSpec), opp = deckOf(oppSpec);
  const out = { complete: mine.length === 4 && opp.length === 4, win: null, killTurn: null, targets: [], protect: [] };
  if (!mine.length) return out;
  const mix = myDamageMix(mine);

  // ce que l'adversaire a intérêt à tuer chez moi (= mes cartes à protéger)
  const fp = Dl.focusPriority(mine);
  const tot = fp.reduce((x, f) => x + f.score, 0) || 1;
  out.protect = fp.map((f) => ({ id: f.card.id, share: f.score / tot }));
  if (!opp.length) return out;

  if (out.complete) {
    const base = series(mine, opp, n);
    out.win = base.wr; out.killTurn = base.turns;
    const oppBase = series(opp, mine, n); // même mesure vue de l'adversaire
    // pour chaque carte adverse : si elle disparaît au tour 1, combien de victoires je gagne ?
    // rapporté au temps qu'il faut pour la tuer (PV effectifs face à mes éléments)
    const res = opp.map(({ card }, k) => {
      const r = series(opp, mine, n, { killA: { k, t: 1 } }); // l'adversaire joue A, sa carte k est retirée
      const gain = Math.max(0, oppBase.margin - r.margin); // ce que l'adversaire perd sans cette carte
      return { id: card.id, gain, eff: effHp(card, mix) };
    });
    const meanEff = res.reduce((x, r) => x + r.eff, 0) / res.length;
    res.forEach((r) => { r.score = (r.gain + 0.02) * (meanEff / r.eff); });
    const s = res.reduce((x, r) => x + r.score, 0) || 1;
    out.targets = res.sort((a, b) => b.score - a.score).map((r) => ({ id: r.id, share: r.score / s, gain: r.gain, eff: Math.round(r.eff) }));
  } else {
    // adversaire incomplet : valeur statique de chaque carte connue / PV effectifs
    const imp = Dl.impacts(opp);
    const res = opp.map(({ card }, k) => ({ id: card.id, eff: effHp(card, mix), score: imp[k] / effHp(card, mix) }));
    const s = res.reduce((x, r) => x + r.score, 0) || 1;
    out.targets = res.sort((a, b) => b.score - a.score).map((r) => ({ id: r.id, share: r.score / s, gain: null, eff: Math.round(r.eff) }));
  }
  return out;
}

// Conseil d'achat : chaque Tox proposé est essayé sur chacune de mes cartes vivantes, en duels contre le deck adverse.
// offers : [idTox|null] ; alive : [bool] par carte de mon deck. Renvoie les options classées par victoires gagnées.
function shopAdvice(mineSpec, oppSpec, offers, alive, n = 100) {
  const mine = deckOf(mineSpec); let opp = deckOf(oppSpec);
  if (!mine.length) return { options: [], base: null };
  if (!opp.length) opp = mine; // adversaire inconnu : on teste contre un miroir
  const base = series(mine, opp, n);
  const options = [];
  offers.forEach((tox, k) => {
    if (!tox) return;
    mine.forEach((d, i) => {
      if (alive && alive[i] === false) return;
      const dk = mine.map((x, j) => (j === i ? { ...x, tox: [...x.tox, tox] } : x));
      const r = series(dk, opp, n);
      options.push({ offer: k, tox, card: d.card.id, wr: r.wr, delta: r.wr - base.wr, dm: r.margin - base.margin });
    });
  });
  options.sort((a, b) => b.delta - a.delta || b.dm - a.dm);
  const perOffer = offers.map((tox, k) => options.find((o) => o.offer === k) || null);
  return { base: base.wr, options, perOffer, oppKnown: oppSpec.length };
}

module.exports = { analyse, shopAdvice, byId };

// utilisation en thread : reçoit {mine, opp, n, key}, renvoie {key, result}
const { parentPort, isMainThread } = require('worker_threads');
if (!isMainThread && parentPort) {
  parentPort.on('message', (m) => {
    try {
      if (m.type === 'shop') parentPort.postMessage({ key: m.key, type: 'shop', result: shopAdvice(m.mine, m.opp, m.offers, m.alive, m.n) });
      else parentPort.postMessage({ key: m.key, result: analyse(m.mine, m.opp, m.n) });
    }
    catch (e) { parentPort.postMessage({ key: m.key, error: String(e && e.stack || e) }); }
  });
}
