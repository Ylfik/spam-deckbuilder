// Statistiques tirées des replays (.srpl) : parties, boutique selon la chance, critiques et ratés.
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'core', 'replay.js'));
const R = globalThis.SpamReplay;
const RAR = { C: 'common', R: 'rare', E: 'epic', L: 'legendary' };

// cherche tous les .srpl sous le dossier des replays (un sous-dossier par serveur et par compte)
function listReplays(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listReplays(p, out); else if (e.name.endsWith('.srpl')) out.push(p);
  }
  return out;
}

function compact(a, guid) {
  const mine = a.casts.filter((c) => c.mine), theirs = a.casts.filter((c) => !c.mine);
  const rate = (arr, k) => (arr.length ? arr.filter((c) => c[k] > 0).length / arr.length : null);
  return {
    uid: a.uid, start: a.start, turns: a.turns, result: a.result, opponent: a.opponent, ai: a.opponentIsAi,
    my: (a.myCards || []).map((g) => guid[g] || g), opp: (a.oppCards || []).map((g) => guid[g] || g),
    shops: a.shops.filter((s) => !s.reroll || true).map((s) => ({ mine: s.mine, luck: s.luck, r: s.offers.map((o) => o.slice(-1)).join('') })),
    crit: rate(mine, 'crit'), miss: rate(mine, 'miss'), oCrit: rate(theirs, 'crit'), casts: mine.length,
  };
}

// table de rareté observée par tranche de chance (toutes les boutiques vues : les miennes et celles de l'adversaire)
function shopTable(games) {
  const bins = [[0, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15], [16, 999]];
  return bins.map(([a, b]) => {
    const c = { C: 0, R: 0, E: 0, L: 0 }; let n = 0;
    for (const g of games) for (const s of g.shops) if (s.luck >= a && s.luck <= b) for (const ch of s.r) if (c[ch] !== undefined) { c[ch]++; n++; }
    return { from: a, to: b, n, p: n ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n])) : null };
  });
}

async function readOne(file, guid) { return compact(await R.readReplay(fs.readFileSync(file)), guid); }

function summary(games) {
  const done = games.filter((g) => g.result !== 'nul');
  const wins = games.filter((g) => g.result === 'victoire').length;
  const avg = (k) => { const v = games.map((g) => g[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return { n: games.length, wins, losses: done.length - wins, crit: avg('crit'), miss: avg('miss'), oCrit: avg('oCrit'), shop: shopTable(games) };
}

module.exports = { listReplays, readOne, summary, shopTable, RAR };
