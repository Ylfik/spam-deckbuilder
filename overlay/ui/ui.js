// Affichage de l'overlay : reçoit l'état de la partie, l'analyse et les statistiques depuis le processus principal.
const $ = (id) => document.getElementById(id);
const pct = (x) => (x == null ? '–' : Math.round(x * 100) + ' %');
const EL = { fire: 'Feu', water: 'Eau', earth: 'Terre', nature: 'Nature', light: 'Lumière', shadow: 'Ombre', divine: 'Divin' };
const img = (id) => `img/${id}.webp`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let M = null, A = null, analysing = false, allCards = [], SHOP = null, ADV = null;
const hpF = (id) => (M && M.hpFrac && M.hpFrac[id] != null ? M.hpFrac[id] : null);

function cardName(id) { return (M && M.cards[id] && M.cards[id].n) || (allCards.find((c) => c.id === id) || {}).n || id; }
function cardEl(id) { return (M && M.cards[id] && M.cards[id].el) || (allCards.find((c) => c.id === id) || {}).el || 'divine'; }
const dot = (id) => `<span class="el" style="background:var(--${cardEl(id)})"></span>`;
function row(id, share, extra, cls) {
  const hp = M && M.hp[id]; const f = hpF(id);
  const dead = (hp && hp.hp <= 0) || f === 0;
  if (f != null && f > 0 && f < 0.995) extra = (extra ? extra + ' · ' : '') + 'PV ' + Math.round(f * 100) + ' %';
  return `<li class="${cls || ''}${dead ? ' dead' : ''}"><span class="fill" style="width:${Math.round((share || 0) * 100)}%"></span>
    <img src="${img(id)}" alt=""><span class="nm">${dot(id)}${esc(cardName(id))}${extra ? `<small>${extra}</small>` : ''}</span><span class="pc">${share == null ? '' : pct(share)}</span></li>`;
}

function render() {
  if (!M) return;
  const live = M.live;
  $('opp-name').textContent = M.opponent ? M.opponent.name : live ? 'Partie en cours' : 'En attente d’une partie';
  $('opp-sub').textContent = M.opponent
    ? [`rang ${M.opponent.rank ?? '?'}`, `${M.opponent.stars ?? '?'} ★`, M.mode, M.turn ? `tour ${M.turn}` : '', !live && M.result ? (M.result === 'Winner' ? 'victoire' : M.result === 'Loser' ? 'défaite' : 'nul') : ''].filter(Boolean).join(' · ')
    : 'Lance une partie classée ou casual';

  // adversaire : ordre de focus (analyse) ou ordre d'apparition en attendant
  const known = M.opp || [];
  let order = A && A.targets && A.targets.length ? A.targets.filter((t) => known.includes(t.id)) : known.map((id) => ({ id, share: null }));
  // PV lus à l'écran : une carte entamée se tue plus vite, elle monte dans l'ordre
  if (order.some((t) => t.share != null && hpF(t.id) != null)) {
    order = order.map((t) => { const f = hpF(t.id); return { ...t, adj: f === 0 ? 0 : (t.share || 0) / Math.max(0.15, f == null ? 1 : f) }; });
    const sAdj = order.reduce((x, t) => x + t.adj, 0) || 1; order = order.map((t) => ({ ...t, share: t.adj / sAdj })).sort((a, b) => b.share - a.share);
  }
  const alive = order.filter((t) => !(M.hp[t.id] && M.hp[t.id].hp <= 0) && hpF(t.id) !== 0);
  let html = order.map((t, k) => row(t.id, t.share, t.eff ? `${t.eff} PV eff.` : '', t === alive[0] ? 'first' : '')).join('');
  for (let k = known.length; k < 4; k++) html += `<li class="unk"><span class="q">?</span><span class="nm">Carte inconnue</span><span class="pc"></span></li>`;
  $('opp-list').innerHTML = html;
  $('opp-hint').classList.toggle('hidden', known.length >= 4 || !live);

  // cible principale
  const tg = alive[0];
  $('s-target').classList.toggle('hidden', !tg || !A);
  if (tg && A) {
    $('t-img').src = img(tg.id); $('t-name').textContent = cardName(tg.id);
    $('t-why').textContent = tg.gain != null
      ? `${pct(tg.share)} de la priorité · ${tg.eff} PV effectifs face à tes éléments`
      : `estimation partielle (${known.length}/4 cartes connues) · ${tg.eff} PV effectifs`;
  }

  // mes cartes
  const prot = A && A.protect && A.protect.length ? A.protect.filter((p) => M.mine.includes(p.id)) : M.mine.map((id) => ({ id, share: null }));
  $('mine-list').innerHTML = prot.map((p, k) => row(p.id, p.share, M.minePinned && !M.minePinned.includes(p.id) ? 'supposée' : '', '')).join('')
    || '<li class="unk"><span class="q">?</span><span class="nm">Deck inconnu : joue une partie ou modifie un deck</span><span class="pc"></span></li>';

  // victoire estimée
  const showWin = A && A.win != null;
  $('s-win').classList.toggle('hidden', !showWin);
  if (showWin) {
    $('win-fill').style.width = Math.round(A.win * 100) + '%';
    $('win-pct').textContent = 'Victoire ' + pct(A.win);
    $('win-sub').textContent = A.killTurn ? `quand tu gagnes : ~${A.killTurn.toFixed(1)} tours · talents adverses inconnus` : 'talents adverses inconnus';
  }
}

// boutique : conseil d'achat à partir des Tox lus à l'écran
function renderShop() {
  const box = $('s-shop'); box.classList.toggle('hidden', !SHOP);
  if (!SHOP) return;
  const nm = (id) => (SHOP.names && SHOP.names[id]) || cardName(id);
  const R = { common: 'commun', rare: 'rare', epic: 'épique', legendary: 'légendaire' };
  const per = ADV && ADV.perOffer;
  $('shop-sub').textContent = [SHOP.turn ? `tour ${SHOP.turn}` : '', SHOP.gold != null ? `${SHOP.gold} or` : '', SHOP.reroll ? `relance ${SHOP.reroll}` : ''].filter(Boolean).join(' · ');
  $('shop-list').innerHTML = SHOP.offers.map((o, k) => {
    const a = per && per[k];
    const name = o.tox ? esc(o.tox.n) + ` <small>${R[o.tox.r] || ''}</small>` : esc(o.name || 'illisible') + ' <small>inconnu du moteur</small>';
    const tip = a ? `sur ${esc(nm(a.card))} <b class="${a.delta >= 0.02 ? 'pos' : 'neu'}">${a.delta >= 0 ? '+' : ''}${Math.round(a.delta * 100)} pts</b>` : ADV ? '<small>sans effet mesurable</small>' : '<span class="spin"></span>';
    return `<li><span class="nm">${name}</span><span class="pr">${o.price != null ? o.price + ' or' : ''}</span><span class="tip">${tip}</span></li>`;
  }).join('');
  let v = '';
  if (ADV && ADV.options) {
    const b = ADV.options[0];
    if (b && b.delta >= 0.02) v = `Achète <b>${esc((SHOP.offers[b.offer].tox || {}).n || '?')}</b> et pose-le sur <b>${esc(nm(b.card))}</b> (+${Math.round(b.delta * 100)} pts de victoire).`;
    else v = 'Aucun Tox ne change vraiment la partie' + (SHOP.reroll ? ` : passe, ou relance pour ${SHOP.reroll} or si tu as de la marge.` : ' : passe.');
    if (ADV.oppKnown < 4) v += ` Calcul fait avec ${ADV.oppKnown}/4 cartes adverses connues.`;
  }
  $('shop-verdict').innerHTML = v || 'Calcul en cours…';
}

function renderStats(S) {
  $('st-sum').textContent = S.n ? `${S.wins} V – ${S.losses} D sur ${S.n} parties` : 'aucun replay lu';
  const rows = S.shop.filter((b) => b.n);
  const lab = (b) => (b.to >= 999 ? `${b.from}+` : `${b.from}–${b.to}`);
  $('shop-table').innerHTML = rows.length
    ? `<tr><th>Chance</th><th>Commun</th><th>Rare</th><th>Épique</th><th>Légend.</th><th>n</th></tr>` +
      rows.map((b) => `<tr><td>${lab(b)}</td><td>${pct(b.p.C)}</td><td class="c-R">${pct(b.p.R)}</td><td class="c-E">${pct(b.p.E)}</td><td class="c-L">${pct(b.p.L)}</td><td>${b.n}</td></tr>`).join('')
    : '';
  $('crit-line').textContent = S.n ? `Mes compétences : ${pct(S.crit)} avec au moins un critique, ${pct(S.miss)} avec un raté · adversaires : ${pct(S.oCrit)} de critiques. La chance monte de 1 par tour.` : 'Les statistiques arrivent après chaque partie (lecture des replays).';
}

window.ov.on('match', (m) => { M = m; render(); });
window.ov.on('analysing', () => { analysing = true; $('status').innerHTML = '<span class="spin"></span>calcul…'; });
window.ov.on('analysis', (a) => { A = a; analysing = false; $('status').textContent = a.complete ? 'analyse à jour' : 'analyse partielle'; render(); });
window.ov.on('stats', renderStats);
window.ov.on('shop', (s) => { const same = SHOP && s && JSON.stringify(s.offers.map((o) => o.tox && o.tox.id)) === JSON.stringify(SHOP.offers.map((o) => o.tox && o.tox.id)); SHOP = s; if (!same) ADV = null; renderShop(); });
window.ov.on('shop-advice', (a) => { ADV = a; renderShop(); });
window.ov.on('vision', (v) => { $('vis').textContent = v.error ? 'écran : erreur' : v.live ? (v.scene === 'shop' ? 'écran : boutique' : 'écran : plateau lu') : 'écran : jeu non visible'; if (v.error) console.error(v.error); });
window.ov.on('status', (s) => { if (!s.log) $('status').textContent = 'Player.log introuvable'; else if (!analysing && !$('status').textContent) $('status').textContent = 'connecté au jeu'; });
window.ov.on('error', (e) => { $('status').textContent = 'erreur d’analyse'; console.error(e); });
window.ov.on('mode', (m) => document.body.classList.toggle('edit', m.edit));

$('b-lock').onclick = () => window.ov.toggleEdit();
$('b-hide').onclick = () => window.ov.hide();
$('b-site').onclick = () => window.ov.openSite();
$('b-dir').onclick = () => window.ov.chooseDir();
$('b-fix').onclick = () => {
  const ids = [0, 1, 2, 3].map((k) => $('fx' + k).value.trim().toLowerCase()).filter(Boolean)
    .map((v) => (allCards.find((c) => c.n.toLowerCase() === v) || {}).id).filter(Boolean);
  window.ov.setOpp(ids);
};
window.ov.allCards().then((cs) => { allCards = cs; $('all').innerHTML = cs.map((c) => `<option value="${esc(c.n)}">`).join(''); });
new ResizeObserver(() => window.ov.height(document.getElementById('app').getBoundingClientRect().height)).observe(document.getElementById('app'));
window.ov.ready();
