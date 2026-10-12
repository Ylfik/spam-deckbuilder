// SPAM — duels deck contre deck et méta
(function (root) {
  const E = root.SpamEngine;
  // hypothèse à tester : l'Éternité appliquée reste sur la carte (+1 à toutes ses recharges), au lieu de +1 une seule fois
  const ETERNITE_PERM = typeof process !== 'undefined' && process.env && process.env.ETERNITE_PERM === '1';
  const { avg, costOf, usesOf, targetOf, buffScope, onCrit, hits, nOptions, dualOf } = E._int;
  const ELS = E.ELS;
  const ALL_EL = [...ELS, 'divine'];
  const DMG = new Set(['damage', 'DamageAll', 'DamageWithCardElement', 'DamageCasterHP', 'DamageOpponentHPMAX']);
  // Générateur pseudo-aléatoire reproductible (mulberry32)
  function makeRng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---------- Famille d'un deck : part des dégâts qui vise une seule carte ----------
  function archetype(deck) {
    let single = 0, multi = 0;
    for (const { card, talent } of deck) {
      const P = E.profile(card, talent);
      for (const ab of card.ab) {
        const lim = usesOf(ab);
        const rate = (lim ? Math.min(1 / Math.max(1, ab.cd), lim / 10) : 1 / Math.max(1, ab.cd)) / nOptions(ab) * (ab.p || 100) / 100;
        const tgt = targetOf(ab);
        for (const a of ab.ac) {
          if (!DMG.has(a[0])) continue;
          const v = avg(a) * rate;
          if (a[0] === 'DamageAll' || tgt === 'allEnemies') multi += v * 4;
          else if (tgt === 'randEnemy' || tgt === 'randField' || tgt === 'allField') multi += v;
          else { single += v; multi += v * P.aoe * 2; }
        }
      }
    }
    const share = single + multi > 0 ? single / (single + multi) : 0.5;
    return { single, multi, share, kind: share >= 0.5 ? 'mono' : 'multi' };
  }

  // ---------- Ce que chaque carte apporte : sert au ciblage adverse et à « protéger en priorité » ----------
  function impacts(deck, opts = {}) {
    const o = { turns: 8, enemyRes: 10, first: true, focus: -1, pressure: 0 };
    const out = (d) => { if (!d.length) return 0; const S = E.simulate(d, o); return S.avg.dmg + 0.5 * S.avg.heal; };
    const full = out(deck);
    return deck.map((_, i) => {
      const without = deck.filter((__, k) => k !== i);
      return Math.max(1, full - out(without));
    });
  }

  // ---------- État d'une équipe ----------
  function makeTeam(deck, first, imp) {
    const st = deck.map(({ card, talent }, i) => {
      const P = E.profile(card, talent);
      const t = P.talent; const ids = card.sk.map((k) => k.id).concat(t && t.g ? [t.g] : []).concat(deck[i].tox || []);
      const has = (re) => ids.some((x) => re.test(x));
      const s = {
        i, card, P, ids, has, tn: t ? t.n : '',
        prec: 0, crit: P.critSelfStatic || 0, ratio: P.critRatioSelf || 0, base: 0,
        baseAb: card.ab.map(() => 0), countAct: card.ab.map(() => 0),
        cd: card.ab.map((ab) => Math.max(0, ab.cd - (first ? 0 : 1))),
        used: card.ab.map(() => 0), lim: card.ab.map(usesOf), cost: card.ab.map(costOf), tgt: card.ab.map(targetOf),
        echo: card.ab.map((ab) => (ab.ech || 0) + (/Roulette/.test(t?.n || '') ? 10 : 0)),
        hpMax: card.hp, hp: card.hp, res: { ...card.res }, resAll: 0,
        alive: true, deathTurn: 0, taunt: 0, tauntTurns: 0, frozen: 0,
        tenacity: has(/^Tenacite/) ? 1 : 0,
      phoenix: has(/^Phoenix_R/) ? 50 : (has(/^Phoenix_C/) || /Nouvelle vie/.test(t?.n || '')) ? 25 : 0,
        cimetiere: has(/^Cimetiere_R/) ? 5 : has(/^Cimetiere_C/) ? 3 : 0,
        imp: imp ? imp[i] : 1, dmgDone: 0, healDone: 0, taken: 0, kills: 0,
        temporality: 0, tempoSrc: has(/^Temporality/), tg: deck[i].tg || {}, immune: has(/^Immunity/),
      };
      ALL_EL.forEach((e) => { if (s.res[e] === undefined) s.res[e] = 0; });
      return s;
    });
    // talents de PV et de résistances
    st.forEach((s) => {
      const t = s.P.talent; if (!t) return;
      for (const a of t.ac) {
        const [eff, , , , el] = a; const v = avg(a);
        if (eff === 'AddCardHPMax' && !/meurt/.test(t.e)) s.hpMax += v;
        else if (eff === 'AddOppHPMax') st.forEach((o) => { if (o !== s) o.hpMax += v; });
        else if (eff === 'AddCardResistance' && v > 0 && !/meurt|subit|Tant que/.test(t.e)) s.res[el] = (s.res[el] || 0) + v;
        else if (eff === 'AddOppCardResistance' && v > 0 && !/subit|adverses/.test(t.e)) st.forEach((o) => (o.res[el] = (o.res[el] || 0) + v));
      }
    });
    st.forEach((s) => { s.hp = s.hpMax; });
    // Temporalité (passif) : sur l'alliée choisie (deck[i].tg.p), sinon sur la carte qui apporte le plus
    st.forEach((s) => {
      if (!s.tempoSrc) return;
      const o = s.tg.p !== undefined && st[s.tg.p] ? st[s.tg.p] : st.reduce((b, x) => (!b || x.imp > b.imp ? x : b), null);
      if (o) o.cd = o.cd.map((c) => Math.max(0, c - 1)); // une seule fois, au début
    });
    const bonus = Object.fromEntries(ALL_EL.map((e) => [e, 0]));
    st.forEach((s) => ELS.forEach((e) => (bonus[e] += s.P.genStart[e])));
    return { st, bonus, first, berserk: 0, deaths: 0, resDown: 0, luck: 1, bought: [] };
  }
  const aliveOf = (team) => team.st.filter((s) => s.alive);
  const resOf = (s, el) => Math.max(-100, Math.min(E.RES_CAP, (s.res[el] || 0) + s.resAll + (s.hp < s.hpMax / 2 && /Résilience/.test(s.tn) ? 25 : 0)));

  // Cible choisie par l'attaquant : la carte qui rapporte le plus à tuer (ce qu'elle apporte / PV effectifs)
  // Cible choisie par l'attaquant : la carte qui rapporte le plus à tuer (ce qu'elle apporte / PV effectifs).
  // Avec de l'AoE, la valeur des deux voisines compte aussi : on vise volontiers la carte du milieu.
  function aiTarget(foe, el, brut, aoe = 0) {
    const al = aliveOf(foe); if (!al.length) return null;
    const val = (s) => (s && s.alive ? s.imp / Math.max(1, s.hp / Math.max(0.1, 1 - (brut ? 0 : resOf(s, el)) / 100)) : 0);
    let best = null, bv = -1;
    for (const s of al) {
      const k = foe.st.indexOf(s);
      const v = val(s) + aoe * (val(foe.st[k - 1]) + val(foe.st[k + 1]));
      if (v > bv) { bv = v; best = s; }
    }
    return best;
  }
  // Répartition d'une attaque monocible : Provocation d'abord (sauf Brut), sinon la cible de l'IA
  function singleWeights(foe, el, brut, aoe = 0) {
    const al = aliveOf(foe); const w = new Map();
    const tSum = brut ? 0 : al.reduce((x, s) => x + s.taunt, 0); const tShare = Math.min(1, tSum);
    if (tShare > 0) al.forEach((s) => { if (s.taunt) w.set(s, (w.get(s) || 0) + tShare * s.taunt / Math.max(1, tSum)); });
    const tg = aiTarget(foe, el, brut, aoe);
    if (tg && tShare < 1) w.set(tg, (w.get(tg) || 0) + (1 - tShare));
    return w;
  }

  function kill(team, foe, s, t, killer) {
    if (s.tenacity) { s.tenacity = 0; s.hp = 1; return; }
    if (s.phoenix) { s.hp = s.hpMax * s.phoenix / 100; s.phoenix = 0; return; }
    s.alive = false; s.hp = 0; s.deathTurn = t; s.taunt = 0; team.deaths++;
    if (killer) { killer.kills++; if (/Reset ultime/.test(killer.tn)) killer.hp = killer.hpMax; }
    for (const side of [team, foe]) side.st.forEach((o) => {
      if (!o.alive) return;
      if (o.has(/^Vengeur/) && o !== killer) o.cd = o.cd.map(() => 0); // Vengeur : récupère toutes ses attaques
      if (o.cimetiere) ELS.forEach((e) => (side.bonus[e] += o.cimetiere));
      if (/Vitalité des Âmes/.test(o.tn)) { o.hpMax += 300; o.hp += 300; }
      if (/One man army/.test(o.tn)) o.base += 5;
      if (/Armure des Âmes/.test(o.tn)) o.resAll += 10;
    });
    if (s.has(/^Revenge/) && foe) { // Revanche : frappe une dernière fois en mourant
      const tg = aiTarget(foe, s.card.el, false); if (tg) hit(team, foe, s, tg, 40, s.card.el, false, t);
    }
  }
  function hit(team, foe, attacker, target, raw, el, brut, t, noSplash) {
    if (!target || !target.alive || raw <= 0) return 0;
    if (target.has(/^Chance/) && /Chance Vitale/.test(target.tn)) raw *= 0.9;
    const d = raw * (1 - (brut ? 0 : resOf(target, el)) / 100);
    target.hp -= d; target.taken += d; attacker.dmgDone += d;
    if (/Cœur d’acier/.test(target.tn)) target.resAll += 1;
    if (/Corrosion/.test(target.tn)) attacker.resAll -= 1;
    if (target.has(/^Reflect/)) { attacker.hp -= 0.75 * d; if (attacker.hp <= 0 && attacker.alive) kill(team, foe, attacker, t, target); }
    const ls = attacker.has(/^Life Steal_E/) ? 0.75 : attacker.has(/^Life Steal_R/) ? 0.5 : attacker.has(/^Life Steal_C/) ? 0.25 : 0;
    if (ls) attacker.hp = Math.min(attacker.hpMax, attacker.hp + ls * d);
    // Poison : chaque coup direct pose une charge (1 % des PV max au début de chacun des 3 tours suivants de la cible, charges cumulables)
    if (!noSplash && attacker.has(/^Poison/) && !target.immune) (target.poison || (target.poison = [])).push(3);
    if (attacker.has(/^Erosion/) && !target.immune) { target.hpMax = Math.max(1, target.hpMax - 0.5 * d); target.hp = Math.min(target.hp, target.hpMax); }
    if (!noSplash && attacker.P.aoe > 0) { // AoE : les cartes voisines prennent une part des dégâts
      const al = foe.st; const k = al.indexOf(target);
      [al[k - 1], al[k + 1]].forEach((n) => { if (n && n.alive) hit(team, foe, attacker, n, raw * attacker.P.aoe, el, brut, t, true); });
    }
    if (target.hp <= 0 && target.alive) kill(foe, team, target, t, attacker);
    return d;
  }
  function healMostHurt(team, amount, caster, healer) {
    let pool = amount;
    for (let k = 0; k < 4 && pool > 0.01; k++) {
      const al = aliveOf(team).filter((s) => s.hp < s.hpMax).sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax);
      if (!al.length) break;
      const s = al[0]; const x = Math.min(pool, s.hpMax - s.hp); s.hp += x; pool -= x; if (healer) healer.healDone += x;
    }
  }

  const phaseOf = (ab) => {
    if (/Applique Provocation/i.test(ab.e) && !ab.ac.some((a) => a[0] === 'RemoveTauntRunning') && !hits(ab)) return 0;
    if (!hits(ab)) return ab.ac.some((a) => a[0] === 'RemoveTauntRunning') ? (ab.ac.some((a) => a[0] === 'AddOppCardBaseDamage') ? 1 : 2) : 1;
    return 3;
  };

  function teamTurn(team, foe, t) {
    const st = team.st; const bonus = team.bonus;
    let curTg = null; // cible choisie pour la compétence en cours (deck[i].tg[index])
    const carry = () => (curTg && curTg.alive ? curTg : aliveOf(team).reduce((b, s) => (!b || s.imp > b.imp ? s : b), null));
    const add = (stat, scope, caster, v) => {
      if (!v) return; const al = aliveOf(team);
      if (scope === 'self') caster[stat] += v;
      else if (scope === 'single') { const c = carry(); if (c) c[stat] += v; }
      else if (scope === 'random') al.forEach((s) => (s[stat] += v / al.length));
      else al.forEach((s) => (s[stat] += v));
    };
    if (team.shop && t % 2 === 0) shopTurn(team, foe, t);
    // chaleur : à partir du tour 20, dégâts bruts croissants sur toutes les cartes de l'équipe qui commence son tour
    if (t >= E.HEAT_START) aliveOf(team).forEach((s) => { const x = s.hpMax * E.HEAT_STEP * (t - E.HEAT_START + 1); s.hp -= x; s.taken += x; if (s.hp <= 0) kill(team, foe, s, t, null); });
    if (!aliveOf(team).length) return;
    team.berserk = st.reduce((x, s) => x + (s.alive ? s.P.berserk : 0), 0);
    const rng = team.rng;
    const roll = (p) => (rng ? (rng() < p ? 1 : 0) : p);
    // AoE : un soin profite aussi aux voisines, à hauteur du pourcentage d'AoE du soin affiché (pas des PV réellement rendus)
    const splashHeal = (o, x, healer) => {
      const h = healer || o; if (!(h.P.aoe > 0) || x <= 0) return;
      const k = st.indexOf(o);
      [st[k - 1], st[k + 1]].forEach((n) => { if (n && n.alive) { const y = Math.min(x * h.P.aoe, n.hpMax - n.hp); n.hp += y; h.healDone += y; } });
    };
    const tankiest = () => { let b = null, be = -1; aliveOf(team).forEach((o) => { const e = o.hp / Math.max(0.1, 1 - (o.resAll + 10) / 100); if (e > be) { be = e; b = o; } }); return b; };
    // début de tour
    st.forEach((s) => {
      if (!s.alive) return;
      if (s.poison && s.poison.length) { const x = s.hpMax * 0.01 * s.poison.length; s.hp -= x; s.taken += x; s.poison = s.poison.map((k) => k - 1).filter((k) => k > 0); if (s.hp <= 0) { kill(team, foe, s, t, null); return; } }
      s.cd = s.cd.map((c) => c - 1);
      if (s.tauntTurns > 0) { s.tauntTurns--; if (s.tauntTurns <= 0) s.taunt = 0; }
      if (/^Focus$/.test(s.tn)) { s.taunt = 1 - (1 - s.taunt) * 0.75; s.tauntTurns = Math.max(s.tauntTurns, 1); }
      if (s.has(/^Primitive heal/)) s.hp = Math.min(s.hpMax, s.hp + s.hpMax * 0.04);
      if (s.has(/^CoeurVital/)) { s.hpMax += 15; s.hp += 15; }
      if (s.has(/^CoeurResistance_C/)) st.forEach((o) => (o.resAll += 3));
      if (s.has(/^CoeurResistance_R/)) st.forEach((o) => (o.resAll += 6));
      if (t === 8 && /Life-8/.test(s.tn)) { s.hpMax *= 2; s.hp *= 2; }
      if (/Revitalisation/.test(s.tn)) s.hp = s.hp + (s.hpMax - s.hp) * 0.05;
      if (/Sursaut Vital/.test(s.tn) && s.hp < s.hpMax * 0.1) s.hp = s.hpMax;
      s.ids.forEach((id) => {
        const m = id.match(/^Coeur(Feu|Eau|Terre|Nature|Ombre|Lumiere)_(C|R)$/);
        if (m) bonus[{ Feu: 'fire', Eau: 'water', Terre: 'earth', Nature: 'nature', Ombre: 'shadow', Lumiere: 'light' }[m[1]]] += m[2] === 'R' ? 2 : 1;
      });
      if (/Boule de Crit/.test(s.tn)) s.crit += 2;
      if (/Incisif/.test(s.tn)) { add('crit', 'team', s, 1); add('prec', 'team', s, 1); }
      if (/Affaiblissement/.test(s.tn)) aliveOf(foe).forEach((o) => (o.resAll -= 1));
    });
    for (const phase of [0, 1, 2, 3]) for (const s of st) {
      if (!s.alive) continue;
      const frozenF = 1 - Math.min(1, s.frozen);
      s.card.ab.forEach((ab, i) => {
        if (!s.alive || !aliveOf(foe).length) return;
        if (phaseOf(ab) !== phase) return;
        if (s.cd[i] > 0 || (s.lim[i] && s.used[i] >= s.lim[i])) return;
        const breaks = ab.ac.some((a) => a[0] === 'RemoveTauntRunning');
        const tauntSum = st.reduce((x, o) => x + (o.alive ? o.taunt : 0), 0);
        if (breaks && tauntSum < 0.01) return;
        const cost = s.cost[i];
        if (cost) {
          const els = Object.keys(cost).filter((k) => k !== 'hp');
          if (els.some((e) => bonus[e] < cost[e])) return;
          els.forEach((e) => (bonus[e] -= cost[e]));
          if (cost.hp) { s.hp -= cost.hp; if (s.hp <= 0) { kill(team, foe, s, t, null); return; } }
        }
        s.used[i]++;
        const opt = nOptions(ab); const tgt = s.tgt[i]; const scope = buffScope(tgt);
        curTg = s.tg[i] !== undefined ? st[s.tg[i]] : null;
        // chance de l'équipe (opts.luckA) : 0,5 = malchanceux (2 fois moins de critiques, 1,5 fois plus de ratés), 1 = normal
        const luck = team.critLuck || 1;
        const prec0 = Math.max(0, Math.min(100, (ab.p || 100) + s.prec)) / 100;
        const prec = Math.max(0, 1 - Math.min(1, (1 - prec0) * (2 - luck))) * frozenF;
        const cc = Math.min(1, Math.max(0, Math.min(100, ab.cc + s.crit)) / 100 * luck);
        const cm = ab.cm + s.ratio;
        const critF = 1 + cc * (cm - 1);
        // tirages d'un lancer : précision et critique pour les effets hors dégâts (bonus, boosts, soins)
        const castF = roll(prec); const castHit = castF > 0;
        const castCrit = rng ? rng() < cc : null;
        const castCritMul = rng ? (castCrit ? cm : 1) : critF;
        const condF = onCrit(ab) ? (rng ? (castCrit ? 1 : 0) : cc) : 1;
        // « Applique Provocation » sans « au lanceur » : le soin, la résistance et la Provocation vont sur l'alliée choisie (la plus solide)
        const allyTarget = /Applique Provocation/i.test(ab.e) && !/au lanceur|al[ée]atoirement/i.test(ab.e) && tgt === 'single' ? tankiest() : null;
        const brut = s.P.brut;
        const thisAttack = /de cette attaque/i.test(ab.e);
        const breakW = breaks ? st.map((o) => (o.alive ? o.taunt / Math.max(1, tauntSum) : 0) * prec) : null;
        if (breaks) st.forEach((o, k) => { o.taunt = Math.max(0, o.taunt - breakW[k]); });
        const mult = (1 + team.berserk / 100);
        let firstTarget = null;
        const dual = dualOf(ab);
        if (dual && castHit) { // dégâts ET soin sur une seule cible : attaquer un adversaire ou soigner une alliée
          const ad = ab.ac[dual.d], ah = ab.ac[dual.h]; const mm = s.P.multiplicator ? 2 : 1;
          const mul = castCritMul * castF * mult; const base = s.base + s.baseAb[i];
          const raw = (avg(ad) / opt + base) * (1 + 0.1 * (bonus[ad[4]] || 0) * mm) * mul;
          const heal = (avg(ah) / opt + base) * (1 + 0.1 * (bonus[ah[4]] || 0) * mm) * mul;
          const dOn = (o, mine) => raw * (1 - (brut && !mine ? 0 : resOf(o, ad[4])) / 100);
          const net = (o, mine) => { const d = dOn(o, mine); if (mine && o.hp <= d) return -1e9; const back = Math.min(heal, o.hpMax - o.hp + d); return mine ? back - d : d - (o.hp <= d ? 0 : back); };
          const w = singleWeights(foe, ad[4], brut, s.P.aoe);
          let atkNet = 0; w.forEach((x, o) => (atkNet += x * net(o, false)));
          const ch = s.tg[i];
          let ally = ch >= 0 && st[ch] && st[ch].alive ? st[ch] : null;
          if (!ally && ch !== -1) ally = aliveOf(team).reduce((b, o) => (!b || net(o, true) > net(b, true) ? o : b), null);
          const healMode = ally && (ch === -2 || ch >= 0 || (ch !== -1 && net(ally, true) > atkNet));
          const applyOn = (o, share, mine) => {
            if (mine) hit(foe, team, s, o, raw * share, ad[4], false, t, true); else hit(team, foe, s, o, raw * share, ad[4], brut, t);
            if (o.alive) { const x = Math.min(heal * share, o.hpMax - o.hp); o.hp += x; if (mine) { s.healDone += x; splashHeal(o, heal * share, s); } }
          };
          if (healMode) applyOn(ally, 1, true);
          else if (rng) { let r = rng(), pick = null; for (const [o, x] of w) { pick = o; if ((r -= x) <= 0) break; } if (pick) applyOn(pick, 1, false); }
          else w.forEach((x, o) => applyOn(o, x, false));
        }
        for (const a of ab.ac) {
          const [eff] = a; const v = avg(a) / opt; let el = a[4]; const eF = roll(prec); const eHit = eF > 0; const pv = v * eF; // précision tirée pour chaque effet (règle confirmée)
          if (dual && (a === ab.ac[dual.d] || a === ab.ac[dual.h])) continue;
          if (eff === 'damage' || eff === 'DamageAll' || eff === 'DamageWithCardElement' || eff === 'DamageCasterHP') {
            if (eff === 'DamageWithCardElement') el = s.card.el;
            const b = (bonus[el] || 0) * (s.P.multiplicator ? 2 : 1);
            let base = v + s.base + s.baseAb[i];
            if (eff === 'DamageCasterHP') base += 0.5 * (s.hpMax - s.hp);
            const raw0 = base * (1 + 0.1 * b) * mult;
            // en mode aléatoire, chaque coup sur chaque cible tire sa précision et son critique
            const per = () => (rng ? (rng() < prec ? (rng() < cc ? cm : 1) : 0) : prec * critF);
            const raw = raw0 * (rng ? 1 : prec * critF);
            const foes = aliveOf(foe); const mine = aliveOf(team);
            const R = () => (rng ? raw0 * per() : raw);
            if (eff === 'DamageAll' || tgt === 'allEnemies') foes.forEach((o) => hit(team, foe, s, o, R(), el, brut, t));
            else if (tgt === 'randEnemy') { if (rng) { const o = foes[Math.floor(rng() * foes.length)]; hit(team, foe, s, o, R(), el, brut, t); firstTarget = o; } else foes.forEach((o) => hit(team, foe, s, o, raw / foes.length, el, brut, t)); }
            else if (tgt === 'allField') { foes.forEach((o) => hit(team, foe, s, o, R(), el, brut, t)); mine.forEach((o) => hit(foe, team, s, o, R(), el, false, t, true)); }
            else if (tgt === 'randField') {
              const n = foes.length + mine.length;
              if (rng) { const k = Math.floor(rng() * n); if (k < foes.length) hit(team, foe, s, foes[k], R(), el, brut, t); else hit(foe, team, s, mine[k - foes.length], R(), el, false, t, true); }
              else { foes.forEach((o) => hit(team, foe, s, o, raw / n, el, brut, t)); mine.forEach((o) => hit(foe, team, s, o, raw / n, el, false, t, true)); }
            }
            else {
              const w = singleWeights(foe, el, brut, s.P.aoe);
              if (rng) { // une seule cible réelle : tirée selon les poids (Provocation ou cible de l'IA)
                let r = rng(), pick = null; for (const [o, x] of w) { pick = o; if ((r -= x) <= 0) break; }
                if (pick) { hit(team, foe, s, pick, R(), el, brut, t); firstTarget = pick; }
              } else w.forEach((x, o) => { hit(team, foe, s, o, raw * x, el, brut, t); if (!firstTarget || x > 0.5) firstTarget = o; });
            }
            if (s.P.multicolor) ELS.forEach((e) => (bonus[e] += prec / Math.max(1, ab.ac.length)));
          } else if (eff === 'DamageOpponentHPMAX') {
            const w = singleWeights(foe, s.card.el, true); w.forEach((x, o) => hit(team, foe, s, o, o.hpMax * avg(a) / 100 * eF * x, s.card.el, true, t));
          } else if (eff === 'healTarget' || eff === 'healCaster') {
            const b = (bonus[el] || 0) * (s.P.multiplicator ? 2 : 1);
            const val = (v + s.base + s.baseAb[i]) * (1 + 0.1 * b) * castCritMul * eF * mult;
            const give = (o) => { const x = Math.min(val, o.hpMax - o.hp); o.hp += x; s.healDone += x; splashHeal(o, val, s); };
            if (!eHit) { /* raté */ }
            else if (eff === 'healCaster') give(s);
            else if (tgt === 'allAllies' || tgt === 'allField') aliveOf(team).forEach(give);
            else if (allyTarget) give(allyTarget);
            else healMostHurt(team, val, s, s);
          } else if (eff === 'healPVmaxCaster' || eff === 'healPVmaxTarget') {
            if (eHit) { const nominal = v >= 100 ? s.hpMax : s.hpMax * v / 100; const x = Math.min(nominal, s.hpMax - s.hp) * eF; s.hp += x; s.healDone += x; splashHeal(s, nominal * eF); }
          } else if (eff === 'healCasterWithoutElement') { const x = Math.min(v, s.hpMax - s.hp) * eF; s.hp += x; s.healDone += x; }
          else if (eff === 'destroy' && /Absorbe une carte$|Absorbe une carte\b(?! alli)/.test(ab.e) && eHit && (rng || prec >= 0.5)) {
            const tg = aiTarget(foe, s.card.el, true); if (tg && !tg.immune) { s.hpMax += tg.hp; s.hp += tg.hp; tg.hp = 0; kill(foe, team, tg, t, s); }
          } else if (eff === 'AddAllPlayerAttack') { if (el) bonus[el] += pv * condF; else ELS.forEach((e) => (bonus[e] += pv * condF)); }
          else if (eff === 'AddAllPlayerAttackRandomTeam') { if (rng) { if (eHit) bonus[ELS[Math.floor(rng() * ELS.length)]] += v; } else ELS.forEach((e) => (bonus[e] += pv / 6)); } // un seul élément tiré au sort
          else if (eff === 'AddAllPlayerAttackWithCardType') bonus[s.card.el] += pv;
          else if (eff === 'AddAllPlayerAttackCountActivation1') { s.countAct[i]++; if (el) bonus[el] += s.countAct[i] * eF; }
          else if (eff === 'StealElement') { if (el) { bonus[el] += pv; foe.bonus[el] = Math.max(0, foe.bonus[el] - pv); } }
          else if (eff === 'ResetSpamton') { /* économie non simulée */ }
          else if (eff === 'AddCardBaseDamage') { if (thisAttack) s.baseAb[i] += pv; else s.base += pv; }
          else if (eff === 'AddAbilityBaseDamage') s.baseAb[i] += pv;
          else if (eff === 'AddOppCardBaseDamage') { if (breaks) st.forEach((o, k) => (o.base += v * breakW[k])); else add('base', scope, s, pv); }
          else if (eff === 'AddAllPlayerCritick') add('crit', 'team', s, pv * condF);
          else if (eff === 'AddCardCriticChance') add('crit', 'self', s, pv * condF);
          else if (eff === 'AddOppCardCriticChance') add('crit', scope, s, pv * condF);
          else if (eff === 'AddAllPlayerMiss') add('prec', 'team', s, -pv);
          else if (eff === 'AddCardMiss') add('prec', 'self', s, -pv);
          else if (eff === 'AddOppCardMiss') {
            if (v > 0) { // précision retirée à l'adversaire
              const tgs = tgt === 'allEnemies' ? aliveOf(foe) : [firstTarget || aiTarget(foe, s.card.el, true)];
              tgs.forEach((o) => { if (o && !o.immune) o.prec -= pv; });
            } else add('prec', scope, s, -pv);
          }
          else if (eff === 'AddCardCriticRatio') add('ratio', 'self', s, pv);
          else if (eff === 'AddOppCardCriticRatio') add('ratio', scope, s, pv);
          else if (eff === 'AddAllPlayerHPMax') aliveOf(team).forEach((o) => { o.hpMax += pv; o.hp += pv; });
          else if (eff === 'AddOppHPMax' && breaks) st.forEach((o, k) => { const x = v * breakW[k]; o.hpMax += x; o.hp += x; });
          else if (eff === 'AddCardResistance') s.resAll += pv / 6;
          else if (eff === 'AddOppCardResistance' && v < 0) { // baisse de résistance d'un élément sur la carte adverse touchée (cumulable)
            const o = firstTarget || aiTarget(foe, s.card.el, true); if (o && !o.immune && el) o.res[el] = (o.res[el] || 0) + pv;
          }
          else if (eff === 'AddOppCardResistance' && v > 0) {
            // compétence sans soin ni attaque (ex. Voile solide de la Sorcière) : la résistance va au lanceur, cumulable jusqu'au plafond de 50 %
            if (!ab.ac.some((x) => /^heal|damage|Damage/.test(x[0]))) { if (el) s.res[el] = (s.res[el] || 0) + pv; else s.resAll += pv / 6; }
            else if (allyTarget) allyTarget.resAll += pv / 6;
            else if (scope === 'team') aliveOf(team).forEach((o) => (o.resAll += pv / 6)); else { const c = carry(); if (c) c.resAll += pv / 6; }
          }
          else if (eff === 'AddCooldown') {
            if (v > 0) { // Éternité sur l'adversaire
              const tgs = tgt === 'allEnemies' || /toutes les cartes adverses/.test(ab.e) ? aliveOf(foe) : [firstTarget || aiTarget(foe, s.card.el, true)];
              tgs.forEach((o) => { if (o && !o.immune && !/Éternisé/.test(o.tn)) { o.cd = o.cd.map((c) => c + eF * condF); if (ETERNITE_PERM) o.eternal = Math.min(1, (o.eternal || 0) + eF * condF); } }); // ETERNITE_PERM : hypothèse « Éternité reste sur la carte »
            } else { // Temporalité : -n tours sur les recharges en cours de la cible (ou de toutes les alliées), une fois
              const tgs = tgt === 'allAllies' || /toutes les cartes alli/i.test(ab.e) ? aliveOf(team) : [carry()].filter(Boolean);
              const n = Math.abs(v) * eF; tgs.forEach((o) => { o.cd = o.cd.map((x) => x - n); });
            }
          }
        }
        // Gel : la cible ne joue pas son prochain tour
        if ((/\bGel\b/.test(ab.e) || s.has(/^Frozen/)) && hits(ab) && firstTarget && !firstTarget.immune) firstTarget.frozen = Math.min(1, firstTarget.frozen + castF);
        // Provocation
        if (/Applique Provocation/i.test(ab.e) && !breaks) {
          const dur = +((ab.e.match(/pendant (\d+) tours/i) || [])[1] || 1);
          const al = aliveOf(team);
          if (/al[ée]atoirement [àa] une carte alli/i.test(ab.e)) {
            if (rng) { if (castHit) { const o = al[Math.floor(rng() * al.length)]; o.taunt = 1; o.tauntTurns = Math.max(o.tauntTurns, dur); } }
            else al.forEach((o) => { o.taunt = 1 - (1 - o.taunt) * (1 - prec / al.length); o.tauntTurns = Math.max(o.tauntTurns, dur); });
          } else {
            const o = /au lanceur/i.test(ab.e) || tgt !== 'single' ? s : (allyTarget || s);
            o.taunt = 1 - (1 - o.taunt) * (1 - castF); o.tauntTurns = Math.max(o.tauntTurns, dur);
          }
        }
        if (s.has(/^Taunt/) && hits(ab)) { s.taunt = 1; s.tauntTurns = Math.max(s.tauntTurns, 1); }
        const cdBase = Math.max(1, ab.cd - s.temporality + (s.eternal || 0) + (ETERNITE_PERM && s.has(/^Eternity/) ? 1 : 0));
        if (rng) s.cd[i] = rng() < s.echo[i] / 100 ? 0 : cdBase; // Écho : la compétence reste disponible
        else s.cd[i] = cdBase * (1 - Math.min(90, s.echo[i]) / 100);
      });
      s.frozen = 0;
    }
  }


  // ---------- Boutique (Tox) ----------
  // Pool : les passifs présents dans le Spamdex (+ les Cœurs de chaque élément en commune et rare).
  // Hypothèses (non communiquées par le jeu) : un achat par passage en boutique (tous les 2 tours, observé en partie),
  // rareté tirée selon la Chance (1 au départ, +1 par tour).
  const EL_TOX = { fire: 'Feu', water: 'Eau', earth: 'Terre', nature: 'Nature', shadow: 'Ombre', light: 'Lumiere' };
  let TOX = null;
  function toxPool(cards) {
    if (TOX) return TOX;
    const m = {};
    cards.forEach((c) => c.sk.forEach((s) => { m[s.id] = { id: s.id, n: s.n, r: s.r, e: s.e }; }));
    ELS.forEach((e) => {
      const nm = { fire: 'feu', water: "d'eau", earth: 'terre', nature: 'nature', shadow: "d'ombre", light: 'lumière' }[e];
      m['Coeur' + EL_TOX[e] + '_C'] = m['Coeur' + EL_TOX[e] + '_C'] || { id: 'Coeur' + EL_TOX[e] + '_C', n: 'Cœur de ' + nm, r: 'common' };
      m['Coeur' + EL_TOX[e] + '_R'] = m['Coeur' + EL_TOX[e] + '_R'] || { id: 'Coeur' + EL_TOX[e] + '_R', n: 'Cœur de ' + nm, r: 'rare' };
    });
    ['ContreCoup_C', 'Eternity_L', 'Mystere_R'].forEach((k) => delete m[k]); // malus ou effet impossible à évaluer
    TOX = Object.values(m);
    return TOX;
  }
  // Chances de rareté en boutique, mesurées sur de vraies parties (replays : 438 Tox proposés).
  // La chance du joueur vaut à peu près le numéro du tour (+ les passifs Chanceur).
  const RARITY_TABLE = [[3, 1, 0, 0, 0], [5, 0.8, 0.2, 0, 0], [7, 0.53, 0.40, 0.07, 0], [9, 0.25, 0.44, 0.31, 0], [11, 0.25, 0.36, 0.39, 0], [13, 0.12, 0.30, 0.58, 0], [15, 0, 0.39, 0.58, 0.03], [99, 0, 0.19, 0.62, 0.19]];
  function rarityOdds(luck, flat) {
    if (flat) return { common: 0.25, rare: 0.25, epic: 0.25, legendary: 0.25 };
    const row = RARITY_TABLE.find((r) => luck <= r[0]);
    return { common: row[1], rare: row[2], epic: row[3], legendary: row[4] };
  }
  // Valeur d'un Tox posé sur une carte (unité : dégâts/soins attendus sur ~8 tours)
  function toxValue(team, foe, s, tox) {
    const al = aliveOf(team); if (!s.alive) return -1;
    if (s.ids.includes(tox.id) || (s.toxCount || 0) >= 2) return -1;
    const out = (o) => o.P.dmg + 0.5 * o.P.heal;
    const tot = al.reduce((x, o) => x + out(o), 0);
    const useTot = al.reduce((x, o) => x + ELS.reduce((y, e) => y + o.P.use[e], 0), 0);
    const id = tox.id; const k = /_R$/.test(id) ? 2 : 1;
    const cm = id.match(/^Coeur(Feu|Eau|Terre|Nature|Ombre|Lumiere)_/);
    if (cm) { const e = Object.keys(EL_TOX).find((x) => EL_TOX[x] === cm[1]); return al.reduce((x, o) => x + o.P.use[e], 0) * k * 3.2 / (s === al[0] ? 1 : 1); }
    if (/^Berserk/.test(id)) return (k === 2 ? 0.25 : 0.12) * tot * 8;
    if (/^Life Steal/.test(id)) return ({ C: 0.25, R: 0.5, E: 0.75 }[id.slice(-1)]) * s.P.dmg * 8 * 0.5;
    if (/^Multiplicator/.test(id)) { const b = ELS.reduce((x, e) => x + team.bonus[e] * s.P.use[e], 0) / Math.max(1, ELS.reduce((x, e) => x + s.P.use[e], 0)); return (b + 8) * 0.1 * s.P.dmg * 8; }
    if (/^Aoe/.test(id)) { const a = { C: 0.2, R: 0.4, E: 0.8 }[id.slice(-1)] - s.P.aoe; return a > 0 ? a * (s.P.dmg + s.P.heal) * 1.3 * 8 * 0.7 : -1; }
    if (/^Cimetiere/.test(id)) return (k === 2 ? 5 : 3) * useTot * 0.1 * 3 * 4;
    if (/^Phoenix/.test(id)) return s.phoenix ? -1 : (k === 2 ? 0.5 : 0.25) * s.hpMax * 0.6 + s.imp * 0.6;
    if (/^Vengeur/.test(id)) return s.card.ab.reduce((x, ab) => x + (ab.cd > 1 ? ab.ac.filter((a) => DMG.has(a[0]) || /heal/i.test(a[0])).reduce((y, a) => y + avg(a), 0) * (ab.cd - 1) / ab.cd : 0), 0) * 2.5;
    if (/^Tenacite/.test(id)) return s.imp * 0.4;
    if (/^Immunity/.test(id)) return s.immune ? -1 : 40 + s.imp * 0.2;
    if (/^Reflect/.test(id)) return 0.75 * 60 * 8 * (s.hp / Math.max(1, s.hpMax));
    if (/^Taunt/.test(id)) return s === tankiestOf(team) ? 60 : 10;
    if (/^Primitive heal/.test(id)) return 0.04 * s.hpMax * 8 * 0.5;
    if (/^CoeurVital/.test(id)) return 15 * 4 * 0.5;
    if (/^CoeurResistance/.test(id)) return (k === 2 ? 6 : 3) * al.length * 6;
    if (/^Frozen/.test(id)) return s.P.hits * 25 * 8 * 0.3;
    if (/^Temporality/.test(id)) return out(s) * 0.6;
    if (/^Brut/.test(id)) return s.P.brut ? -1 : s.P.dmg * 0.12 * 8 + 15;
    if (/^Erosion/.test(id)) return s.P.dmg * 0.5 * 8 * 0.3;
    if (/^PunchingBag/.test(id)) return (al.reduce((x, o) => x + o.P.use[s.card.el], 0)) * 0.1 * 2 * 8;
    if (/^Revenge/.test(id)) return s.P.dmg * 1.5;
    if (/^Poison/.test(id)) return s.P.hits * 15;
    if (/^Reset/.test(id)) return s.P.dmg * 1.2;
    if (/^Mimetisme/.test(id)) return useTot * 0.15 * 8;
    if (/^Disparition/.test(id)) return 35;
    if (/^Smoked/.test(id)) return 20;
    if (/^Chance/.test(id)) return 12;
    if (/^Spamland/.test(id)) return 12;
    return 10;
  }
  const tankiestOf = (team) => { let b = null, be = -1; aliveOf(team).forEach((o) => { const e = o.hp / Math.max(0.1, 1 - (o.resAll + 10) / 100); if (e > be) { be = e; b = o; } }); return b; };
  function applyTox(s, tox) {
    const id = tox.id;
    s.ids.push(id); s.toxCount = (s.toxCount || 0) + 1; s.toxes = (s.toxes || []).concat([tox.n]);
    if (/^Berserk_C/.test(id)) s.P.berserk += 12; else if (/^Berserk_R/.test(id)) s.P.berserk += 25;
    if (/^Multiplicator/.test(id)) s.P.multiplicator = true;
    if (/^Aoe_/.test(id)) s.P.aoe = Math.max(s.P.aoe, { C: 0.2, R: 0.4, E: 0.8 }[id.slice(-1)]);
    if (/^Brut/.test(id)) s.P.brut = true;
    if (/^Immunity/.test(id)) s.immune = true;
    if (/^Temporality/.test(id)) s.cd = s.cd.map((c) => c - 1); // effet ponctuel
    if (/^Phoenix/.test(id) && !s.phoenix) s.phoenix = /_R$/.test(id) ? 50 : 25;
    if (/^Cimetiere/.test(id)) s.cimetiere += /_R$/.test(id) ? 5 : 3;
    if (/^Tenacite/.test(id)) s.tenacity = 1;
  }
  function shopTurn(team, foe, t) {
    const rng = team.rng || team.shopRng; const pool = toxPool(team.allCards);
    team.luck = t + (team.extraLuck || 0) + (team.luckTurn || 0) * t;
    const odds = rarityOdds(team.luck, team.flatOdds);
    const offers = [];
    for (let k = 0; k < 3; k++) {
      let r = rng(), rar = 'common'; for (const x of ['legendary', 'epic', 'rare', 'common']) { if ((r -= odds[x]) <= 0) { rar = x; break; } }
      const list = pool.filter((p) => p.r === rar); offers.push(list[Math.floor(rng() * list.length)]);
    }
    let best = null;
    for (const tox of offers) for (const s of aliveOf(team)) { const v = toxValue(team, foe, s, tox); if (v > 0 && (!best || v > best.v)) best = { tox, s, v }; }
    if (best) { applyTox(best.s, best.tox); team.bought.push({ t, card: best.s.card.n, tox: best.tox.n }); }
  }

  // Un duel : A et B jouent chacun leur tour. Résultat en valeurs moyennes (précision et critique « lissés »).
  function duel(deckA, deckB, opts = {}) {
    const aFirst = opts.aFirst !== false; const maxT = opts.maxTurns || 30;
    const impA = opts.impA || impacts(deckA), impB = opts.impB || impacts(deckB);
    const A = makeTeam(deckA, aFirst, impA), B = makeTeam(deckB, !aFirst, impB);
    if (opts.seed !== undefined) { const r = makeRng(opts.seed); A.rng = r; B.rng = r; }
    if (opts.luckA) A.critLuck = opts.luckA; // multiplicateur de chance aux critiques (distinct de la chance de boutique)
    if (opts.shop) {
      const cards = opts.allCards || root.__SPAM_CARDS || [];
      [A, B].forEach((T, k) => { T.shop = true; T.allCards = cards; T.shopRng = makeRng((opts.seed || 12345) + 17 + k * 1000); T.flatOdds = T.st.some((s) => /Tox chanceux/.test(s.tn)); T.extraLuck = T.st.reduce((x, s) => x + (s.P.luck || 0), 0); T.luckTurn = T.st.reduce((x, s) => x + (s.P.luckTurn || 0), 0); });
    }
    const order = aFirst ? [[A, B], [B, A]] : [[B, A], [A, B]];
    let t = 1, winner = null;
    const deathsLog = [];
    const logDeaths = (side, team) => team.st.forEach((s) => { if (!s.alive && !s.logged) { s.logged = true; deathsLog.push({ side, card: s.card, t }); } });
    for (; t <= maxT && !winner; t++) {
      // carte retirée de force à un tour donné (mesure « à protéger ») : morte définitivement, sans Phénix ni Ténacité
      if (opts.killA && opts.killA.t === t) { const s = A.st[opts.killA.k]; if (s && s.alive) { s.phoenix = 0; s.tenacity = 0; kill(A, B, s, t, null); } }
      for (const [me, foe] of order) {
        teamTurn(me, foe, t);
        logDeaths('A', A); logDeaths('B', B);
        if (!aliveOf(B).length) { winner = 'A'; break; }
        if (!aliveOf(A).length) { winner = 'B'; break; }
      }
    }
    const hpFrac = (T) => T.st.reduce((x, s) => x + Math.max(0, s.hp) / s.hpMax, 0) / T.st.length;
    // limite de tours atteinte : match nul (la règle réelle de fin de partie n'est pas connue)
    if (!winner) winner = opts.hpTiebreak ? (hpFrac(A) > hpFrac(B) + 0.02 ? 'A' : hpFrac(B) > hpFrac(A) + 0.02 ? 'B' : 'nul') : 'nul';
    const side = (T) => T.st.map((s) => ({ id: s.card.id, n: s.card.n, deathTurn: s.deathTurn, hp: Math.max(0, s.hp), hpMax: s.hpMax, dmg: s.dmgDone, heal: s.healDone, kills: s.kills, toxes: s.toxes || [] }));
    return { winner, turns: Math.min(t, maxT), A: side(A), B: side(B), hpA: hpFrac(A), hpB: hpFrac(B), deaths: deathsLog, boughtA: A.bought, boughtB: B.bought };
  }

  // Duel aller-retour (chacun commence une fois)
  function match(deckA, deckB, impA, impB) {
    const d1 = duel(deckA, deckB, { aFirst: true, impA, impB });
    const d2 = duel(deckA, deckB, { aFirst: false, impA, impB });
    const pts = (d) => (d.winner === 'A' ? 1 : d.winner === 'nul' ? 0.5 : 0);
    return { score: (pts(d1) + pts(d2)) / 2, games: [d1, d2] };
  }

  // Série de duels aléatoires (précision, critiques, Écho, Provocations au hasard tirés au sort)
  function series(deckA, deckB, n = 40, impA, impB, seed0 = 1, shop = true) {
    impA = impA || impacts(deckA); impB = impB || impacts(deckB);
    let win = 0, nul = 0, turns = 0; const toxCountA = {};
    const firstDeathA = deckA.map(() => 0), deathA = deckA.map(() => 0), deathB = deckB.map(() => 0), firstDeathB = deckB.map(() => 0);
    for (let k = 0; k < n; k++) {
      const d = duel(deckA, deckB, { aFirst: k % 2 === 0, impA, impB, seed: seed0 * 7919 + k * 104729, shop });
      d.boughtA.forEach((b) => { toxCountA[b.tox] = (toxCountA[b.tox] || 0) + 1; });
      if (d.winner === 'A') win++; else if (d.winner === 'nul') nul++;
      turns += d.turns;
      const fa = d.deaths.find((x) => x.side === 'A'); if (fa) firstDeathA[deckA.findIndex((x) => x.card === fa.card)]++;
      const fb = d.deaths.find((x) => x.side === 'B'); if (fb) firstDeathB[deckB.findIndex((x) => x.card === fb.card)]++;
      d.A.forEach((x, i) => { if (x.deathTurn) deathA[i]++; }); d.B.forEach((x, i) => { if (x.deathTurn) deathB[i]++; });
    }
    const f = (a) => a.map((x) => x / n);
    return { n, winRate: (win + nul / 2) / n, turns: turns / n, firstDeathA: f(firstDeathA), firstDeathB: f(firstDeathB), deathA: f(deathA), deathB: f(deathB), toxA: toxCountA };
  }

  // Ordre de priorité des cibles pour l'adversaire = ce qu'il faut protéger
  function focusPriority(deck, imp) {
    imp = imp || impacts(deck);
    return deck.map(({ card }, i) => {
      const r = Object.values(card.res).reduce((a, b) => a + b, 0) / 6;
      const eff = card.hp / (1 - r / 100);
      return { card, i, imp: imp[i], eff, score: imp[i] / eff };
    }).sort((a, b) => b.score - a.score);
  }

  root.SpamDuel = { archetype, impacts, duel, match, series, focusPriority, makeTeam, makeRng, toxPool, teamTurn };
})(typeof window !== 'undefined' ? window : globalThis);
