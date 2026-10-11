// SPAM — moteur d'analyse et de synergies (fonctionne sur le format compact)
// Format carte : {id,no,n,el,r,sp,hp,res,img,ar,ab:[{n,e,cd,el,p,cc,cm,u,ech,ac:[[effect,kind,min,max,element]]}],sk:[{id,n,e,r,el}],ta:[{s,n,e,el,g,ac}]}
(function (root) {
  const ELS = ['fire', 'water', 'earth', 'nature', 'light', 'shadow'];
  // Règles de jeu confirmées : résistance plafonnée à 50 %. Chaleur dès le tour 20 (forme exacte inconnue :
  // hypothèse = dégâts bruts de 5 % des PV max au tour 20, +5 % par tour ensuite, sur toutes les cartes).
  const RES_CAP = 50, HEAT_START = 20, HEAT_STEP = 0.05;
  const avg = (a) => (a[2] + a[3]) / 2;
  const nOptions = (ab) => (ab.e.match(/-{5,}\s*ou\s*-{5,}/g) || []).length + 1;
  const zero = () => Object.fromEntries([...ELS, 'divine'].map((e) => [e, 0]));
  const EL_BY_FR = { feu: 'fire', eau: 'water', terre: 'earth', nature: 'nature', lumière: 'light', lumiere: 'light', ombre: 'shadow' };
  // Coût en bonus élémentaires : "[Coût 2 Feu & 2 Ombre]" -> {fire:2, shadow:2} ; "[Coût 100 PV]" -> {hp:100}
  function costOf(ab) {
    const m = ab.e.match(/\[Co[uû]t ([^\]]+)\]/i); if (!m) return null;
    const c = {};
    for (const part of m[1].split('&')) {
      const x = part.trim().match(/^(\d+)\s+(.+)$/); if (!x) continue;
      const k = x[2].trim().toLowerCase();
      if (k === 'pv') c.hp = +x[1]; else if (EL_BY_FR[k]) c[EL_BY_FR[k]] = +x[1];
    }
    return c;
  }
  const usesOf = (ab) => { const m = ab.e.match(/Usage Limit[ée]e? (\d+)\/(\d+)/i); return m ? +m[2] : (ab.u || 0); };

  // Ciblage écrit sur la compétence. Sans mention : monocible (une carte adverse pour une attaque,
  // une carte alliée pour un soin ou un boost).
  function targetOf(ab) {
    const t = ab.e;
    if (/Cible toutes les cartes adverses/i.test(t)) return 'allEnemies';
    if (/Cible al[ée]atoirement (les cartes|une carte) adverses?/i.test(t)) return 'randEnemy';
    if (/Cible toutes les cartes alli[ée]es/i.test(t)) return 'allAllies';
    if (/Cible al[ée]atoirement les cartes alli[ée]es|al[ée]atoirement sur une carte alli[ée]e/i.test(t)) return 'randAlly';
    if (/Cible toutes les cartes du terrain/i.test(t)) return 'allField';
    if (/Cible al[ée]atoirement les cartes du terrain/i.test(t)) return 'randField';
    return 'single';
  }
  // Part des dégâts qui touchent l'adversaire / tes propres cartes, en nombre de cartes touchées
  function dmgSplit(eff, tgt) {
    if (tgt === 'allField') return { enemy: 4, ally: 4 };
    if (tgt === 'randField') return { enemy: 0.5, ally: 0.5 };
    if (eff === 'DamageAll' || tgt === 'allEnemies') return { enemy: 4, ally: 0 };
    return { enemy: 1, ally: 0 };
  }
  // Attaque + soin sur UNE même cible (Épine Médusine) : on choisit à chaque lancer d'attaquer un adversaire ou de soigner une alliée
  function dualOf(ab) {
    if (targetOf(ab) !== 'single') return null;
    const d = ab.ac.findIndex((a) => a[0] === 'damage'), h = ab.ac.findIndex((a) => a[0] === 'healTarget');
    return d >= 0 && h >= 0 ? { d, h } : null;
  }
  function healMult(tgt) { return tgt === 'allAllies' || tgt === 'allField' ? 4 : tgt === 'randField' ? 0.5 : 1; }
  // Un boost « alliés » (AddOppCard…) : toutes les alliées, une alliée au hasard, ou la carte choisie (monocible)
  function buffScope(tgt) { return tgt === 'allAllies' || tgt === 'allField' ? 'team' : tgt === 'randAlly' || tgt === 'randField' ? 'random' : 'single'; }
  const onCrit = (ab) => /en cas de coup critique/i.test(ab.e);
  const HIT_EFFECTS = new Set(['damage', 'DamageAll', 'DamageWithCardElement', 'DamageCasterHP', 'DamageOpponentHPMAX', 'healTarget', 'healCaster', 'healPVmaxTarget', 'healPVmaxCaster', 'healCasterWithoutElement', 'HealCasterWithOppHPMAX']);
  const hits = (ab) => ab.ac.some((a) => HIT_EFFECTS.has(a[0]));

  // ---------- Profil statique d'une carte (avec le talent choisi) ----------
  function profile(card, talentSlot) {
    const P = {
      gen: zero(), genStart: zero(), use: zero(), dmgEl: zero(), healEl: zero(), heal: 0, dmg: 0, hits: 0, critHits: 0,
      baseTeam: 0, baseSelf: 0, critTeam: 0, critSelf: 0, precTeam: 0, critRatio: 0,
      tauntRandomAlly: 0, tauntSelf: 0, tauntBreakBase: 0,
      precSelf: 0, precSingle: 0, critSingle: 0, ratioSingle: 0, baseSingle: 0, friendly: 0, precDebuff: 0,
      berserk: 0, multiplicator: false, aoe: 0, hpTeam: 0, resTeam: 0,
      deathPayoff: [], deathEnabler: [], taunt: 0, brut: false, eternity: 0, temporality: 0,
      spTurn: card.sp, spStart: 0, luck: 0, luckTurn: 0, freeze: false, lifesteal: 0,
      tags: new Set(), notes: [], hp: card.hp,
      lowPrec: card.ab.some((ab) => (ab.p || 100) <= 50 && hits(ab)),
    };
    const talent = card.ta.find((t) => t.s === talentSlot) || null;

    for (const ab of card.ab) {
      const opts = nOptions(ab);
      const lim = usesOf(ab);
      const rate = (lim ? Math.min(1 / Math.max(1, ab.cd), lim / 10) : 1 / Math.max(1, ab.cd) * (1 + (ab.ech || 0) / 100)) / opts;
      if (costOf(ab)) P.tags.add('Coût en éléments');
      if (lim) P.tags.add('Usage limité');
      const prec = (ab.p || 100) / 100;
      const txt = ab.e;
      const tgt = targetOf(ab);
      const scope = buffScope(tgt);
      const condF = onCrit(ab) ? Math.max(0.01, ab.cc / 100) : 1; // effets « en cas de coup critique »
      const r = rate * prec; // la précision conditionne tous les effets de la compétence
      if (tgt === 'randField' || tgt === 'allField') P.tags.add('Touche aussi tes cartes');
      if (tgt === 'single' && card.ab.length) P.tags.add('Monocible');
      const breaks = ab.ac.some((a) => a[0] === 'RemoveTauntRunning');
      if (/Applique Provocation/i.test(txt) && !breaks) {
        P.taunt += rate * opts; P.tags.add('Provocation');
        if (/al[ée]atoirement [àa] une carte alli/i.test(txt)) P.tauntRandomAlly += r; else P.tauntSelf += r;
      }
      if (/Gel/.test(txt)) { P.freeze = true; P.tags.add('Gel'); }
      if (/Absorbe/.test(txt)) { P.deathEnabler.push(ab.n + ' (Absorbe)'); P.tags.add('Absorbe'); }
      for (const a of ab.ac) {
        const [eff, kind] = a; const v = avg(a); const el = a[4];
        switch (eff) {
          case 'damage': case 'DamageAll': case 'DamageCasterHP': case 'DamageWithCardElement': {
            const e = eff === 'DamageWithCardElement' ? card.el : el;
            const sp = dmgSplit(eff, tgt);
            if (e && P.use[e] !== undefined) { P.use[e] += v * r * sp.enemy; P.dmgEl[e] += v * r * sp.enemy; }
            P.dmg += v * r * sp.enemy; P.friendly += v * r * sp.ally; P.hits += rate * sp.enemy;
            P.critHits += rate * sp.enemy;
            if (sp.enemy > 1) P.tags.add('Zone');
            break;
          }
          case 'DamageOpponentHPMAX': P.hits += rate; P.tags.add('% PV max'); break;
          case 'healTarget': case 'healCaster': {
            const mult = eff === 'healCaster' ? 1 : healMult(tgt);
            if (el) { P.use[el] += v * r * mult; if (P.healEl[el] !== undefined) P.healEl[el] += v * r * mult; }
            P.heal += v * r * mult; P.hits += rate * mult; P.tags.add('Soin');
            P.critHits += rate * mult;
            break;
          }
          case 'healPVmaxTarget': case 'healPVmaxCaster': case 'healCasterWithoutElement': case 'HealCasterWithOppHPMAX':
            P.tags.add('Soin'); break;
          case 'AddAllPlayerAttack':
            if (el) P.gen[el] += v * r * condF; else ELS.forEach((e) => (P.gen[e] += v * r * condF));
            break;
          case 'AddAllPlayerAttackRandomTeam': ELS.forEach((e) => (P.gen[e] += (v * r) / 6)); P.tags.add('Bonus aléatoire'); break;
          case 'AddAllPlayerAttackWithCardType': P.gen[card.el] += v * r; break;
          case 'AddAllPlayerAttackCountActivation1': if (el) P.gen[el] += 3 * r; P.tags.add('Bonus croissant'); break;
          case 'StealElement': if (el) P.gen[el] += v * r; P.tags.add('Vol d\'élément'); break;
          case 'AddCardBaseDamage': case 'AddAbilityBaseDamage': P.baseSelf += v * r; break;
          case 'AddOppCardBaseDamage':
            if (breaks) { P.tauntBreakBase += v * r; P.tags.add('Brise une Provocation'); break; }
            if (scope === 'team') P.baseTeam += v * r; else if (scope === 'random') P.baseTeam += v * r / 4; else P.baseSingle += v * r;
            break;
          case 'RemoveTauntRunning': P.tags.add('Brise-provocation'); break;
          case 'AddAllPlayerCritick': P.critTeam += v * r * condF; break;
          case 'AddCardCriticChance': P.critSelf += v * r * condF; break;
          case 'AddOppCardCriticChance':
            if (scope === 'team') P.critTeam += v * r * condF; else if (scope === 'random') P.critTeam += v * r * condF / 4; else P.critSingle += v * r * condF;
            break;
          // Dans les données, « Miss » négatif = gain de précision ; positif = précision retirée
          case 'AddAllPlayerMiss': P.precTeam += -v * r; break;
          case 'AddCardMiss': P.precSelf += -v * r; break;
          case 'AddOppCardMiss':
            if (v > 0) { P.precDebuff += v * r; P.tags.add('Réduit la précision adverse'); }
            else if (scope === 'team') P.precTeam += -v * r; else if (scope === 'random') P.precTeam += -v * r / 4; else P.precSingle += -v * r;
            break;
          case 'AddCardCriticRatio': P.critRatioSelfRate = (P.critRatioSelfRate || 0) + v * r; break;
          case 'AddOppCardCriticRatio':
            if (scope === 'team') P.critRatio += v * r; else P.ratioSingle += v * r;
            break;
          case 'AddAllPlayerHPMax': P.hpTeam += v * rate; break;
          case 'AddOppCardResistance': P.resTeam += (v * rate) / 6; break;
          case 'AddCooldown': if (v > 0) { P.eternity += rate; P.tags.add('Éternité'); } else { P.temporality += rate; P.tags.add('Temporalité'); } break;
          case 'ResetSpamton': P.tags.add('Anti-Spamton'); break;
          case 'destroy': break;
          default: break;
        }
      }
    }

    // Passifs de départ (skills) + passif accordé par le talent
    const passives = card.sk.map((s) => s.id);
    if (talent && talent.g) passives.push(talent.g);
    for (const id of passives) applyPassive(P, id, card);

    // Talent choisi
    if (talent) applyTalent(P, talent, card);
    P.talent = talent;
    P.passives = passives;
    return P;
  }

  function applyPassive(P, id, card) {
    const m = id.match(/^Coeur(Feu|Eau|Terre|Nature|Ombre|Lumiere)_(C|R)$/);
    if (m) {
      const map = { Feu: 'fire', Eau: 'water', Terre: 'earth', Nature: 'nature', Ombre: 'shadow', Lumiere: 'light' };
      P.gen[map[m[1]]] += m[2] === 'R' ? 2 : 1; P.tags.add('Cœur élémentaire'); return;
    }
    if (/^Chance_C/.test(id)) { P.luckTurn += 0.5; return; }
    if (/^Chance_R/.test(id)) { P.luckTurn += 1; return; }
    if (/^Spamland/.test(id)) { P.spTurn += 3; return; }
    if (/^Brut/.test(id)) { P.brut = true; P.tags.add('Brut'); return; }
    if (/^Phoenix/.test(id)) { P.deathEnabler.push('Phénix (revient à la vie)'); P.tags.add('Phénix'); return; }
    if (/^Cimetiere_(C|R)/.test(id)) { P.deathPayoff.push('Cimetière (+' + (id.endsWith('R') ? 5 : 3) + ' tous éléments par mort)'); P.tags.add('Cimetière'); return; }
    if (/^Berserk_C/.test(id)) { P.berserk += 12; P.tags.add('Berserk'); return; }
    if (/^Berserk_R/.test(id)) { P.berserk += 25; P.tags.add('Berserk'); return; }
    if (/^Multiplicator/.test(id)) { P.multiplicator = true; P.tags.add('Multiplicateur'); return; }
    if (/^Aoe_C/.test(id)) { P.aoe += 0.2; P.tags.add('AoE'); return; }
    if (/^Aoe_R/.test(id)) { P.aoe += 0.4; P.tags.add('AoE'); return; }
    if (/^Aoe_E/.test(id)) { P.aoe += 0.8; P.tags.add('AoE'); return; }
    if (/^Taunt/.test(id)) { P.taunt += 1; P.tags.add('Provocation'); return; }
    if (/^Eternity/.test(id)) { P.eternity += 1; P.tags.add('Éternité'); return; }
    if (/^Temporality/.test(id)) { P.temporality += 1; P.tags.add('Temporalité'); return; }
    if (/^Vengeur/.test(id)) { P.deathPayoff.push('Vengeur (récupère ses attaques à chaque mort)'); P.tags.add('Vengeur'); return; }
    if (/^Revenge/.test(id)) { P.deathEnabler.push('Revanche (frappe en mourant)'); P.tags.add('Revanche'); return; }
    if (/^Frozen/.test(id)) { P.freeze = true; P.tags.add('Gel'); return; }
    if (/^Life Steal_(C|R|E)/.test(id)) { P.lifesteal += { C: 25, R: 50, E: 75 }[id.slice(-1)]; P.tags.add('Vampirisme'); return; }
    if (/^CoeurResistance_C/.test(id)) { P.resTeam += 3; P.tags.add('Résistance d\'équipe'); return; }
    if (/^CoeurResistance_R/.test(id)) { P.resTeam += 6; P.tags.add('Résistance d\'équipe'); return; }
    if (/^PunchingBag/.test(id)) { P.gen[card.el] += 0.5; P.tags.add('Sac de frappe'); return; }
    if (/^Mimetisme/.test(id)) { P.tags.add('Mimétisme'); return; }
    if (/^Reset_E/.test(id)) { P.tags.add('Reset'); return; }
    if (/^Reflect/.test(id)) { P.tags.add('Renvoi'); return; }
    if (/^Immunity/.test(id)) { P.tags.add('Immunité'); return; }
    if (/^Smoked/.test(id)) { P.tags.add('Fumée'); return; }
    if (/^Poison/.test(id)) { P.tags.add('Poison'); return; }
    if (/^Erosion/.test(id)) { P.tags.add('Érosion'); return; }
    if (/^MetamorphSimple/.test(id)) { P.tags.add('Métamorphe'); return; }
    if (/^CoeurVital/.test(id)) { P.tags.add('Cœur vital'); return; }
    if (/^Primitive heal/.test(id)) { P.tags.add('Soin primitif'); return; }
    if (/^Tenacite/.test(id)) { P.tags.add('Ténacité'); return; }
    if (/^ContreCoup/.test(id)) { P.tags.add('Contrecoup'); return; }
    if (/^Disparition/.test(id)) { P.tags.add('Disparition'); return; }
    if (/^Mystere|^CoeurCorrompu/.test(id)) { P.tags.add('Passif aléatoire'); return; }
  }

  function applyTalent(P, t, card) {
    const txt = t.e;
    const perTurn = /par tour|chaque tour|à chaque tour/i.test(txt);
    for (const a of t.ac) {
      const [eff] = a; const v = avg(a); const el = a[4];
      switch (eff) {
        case 'AddAllPlayerAttack':
          if (el) P.genStart[el] += v; else ELS.forEach((e) => (P.genStart[e] += v));
          break;
        case 'AddOppHPMax': P.hpTeamStatic = (P.hpTeamStatic || 0) + v; break;
        case 'AddCardCriticChance': if (perTurn) P.critSelf += v; else P.critSelfStatic = (P.critSelfStatic || 0) + v; break;
        case 'AddOppCardCriticChance': if (perTurn) P.critTeam += v; break;
        case 'AddOppCardMiss': if (/vos cartes/.test(txt) && perTurn) P.precTeam += Math.abs(v); break;
        case 'AddCardCriticRatio': P.critRatioSelf = (P.critRatioSelf || 0) + v; break;
        case 'AddSpamton': if (/début de la partie/.test(txt)) P.spStart += v; break;
        case 'AddSpamtonGenerationCaster': if (perTurn) P.spGrow = (P.spGrow || 0) + v; else P.spTurn += v; break;
        case 'AddLuck': P.luck += v; break;
        case 'AddOppCardResistance': if (v > 0) P.resTeamStatic = v; break;
        case 'AddSAttackMulticolor': P.multicolor = true; P.tags.add('Multicolore'); break;
        default: break;
      }
    }
    if (/Dès qu'une carte sur le terrain meurt|Chaque fois qu'une autre carte meurt/.test(txt)) { P.deathPayoff.push(t.n); P.tags.add('Paie sur les morts'); }
    if (/Quand cette carte est tuée|quand celle-ci (est tuée|meurt)|quand cette carte est tuée/i.test(txt)) { P.deathEnabler.push(t.n + ' (en mourant)'); }
    if (/Provocation/.test(txt)) { P.taunt += 0.25; P.tags.add('Provocation'); }
    if (/Éternité/.test(txt) && !/insensible/.test(txt)) P.tags.add('Éternité');
    if (/Temporalité/.test(txt)) P.tags.add('Temporalité');
  }

  // ---------- Simulation tour par tour ----------
  // opts: {turns, enemyRes (0-100), enemyHP, first (true = je joue en premier), focus (index de la carte
  //        qui reçoit les boosts monocibles, -1 = automatique)}
  // Règles de départ : toutes les recharges commencent au maximum. Le premier joueur gagne en plus le
  // Spamton de ses cartes ; le second joueur profite d'une Temporalité (−1 recharge) sur toutes ses cartes.
  // Une compétence de recharge N attend donc N tours (N − 1 en jouant second) avant son premier lancer.
  // Dégâts par tour d'un deck construit correct : 90e centile lissé de 800 decks tirés au hasard dans le Spamdex
  // (avec talents, sans boutique). Sert de pression adverse : opts.pressure multiplie cette courbe (0 = pas d'adversaire).
  // Repères : ×0,55 ≈ deck médian, ×0,78 ≈ 75e centile, ×1 = 90e centile.
  const REF_PRESSURE = [100, 120, 140, 160, 180, 200, 220, 245, 270, 295, 320, 340, 365, 395, 430];
  const refPressure = (t) => (t <= REF_PRESSURE.length ? REF_PRESSURE[t - 1] : REF_PRESSURE[REF_PRESSURE.length - 1] + 30 * (t - REF_PRESSURE.length));
  const avgRes = (res) => ELS.reduce((x, e) => x + (res[e] || 0), 0) / ELS.length;
  // Ce que l'adversaire perd à laisser vivre une carte : sert à choisir sa cible (la plus rentable à tuer)
  function importance(P) {
    const gen = ELS.reduce((x, e) => x + P.gen[e], 0);
    return 1 + P.dmg + 0.5 * P.heal + 5 * gen + 6 * (P.baseTeam * 4 + P.baseSingle + P.tauntBreakBase + P.baseSelf)
      + 1.2 * (P.critTeam * 4 + P.critSingle + P.critSelf) + 0.8 * (P.precTeam * 4 + P.precSingle + P.precSelf)
      + 8 * (P.critRatio * 4 + P.ratioSingle) + 0.5 * P.berserk;
  }
  function pickFocus(deck, opts) {
    if (opts.focus >= 0 && opts.focus < deck.length) return opts.focus;
    let best = 0, bv = -1;
    deck.forEach(({ card, talent }, i) => { const P = profile(card, talent); const v = P.dmg + 0.5 * P.heal; if (v > bv) { bv = v; best = i; } });
    return best;
  }
  function simulate(deck, opts) {
    const T = opts.turns || 10; const enemyRes = (opts.enemyRes ?? 10) / 100;
    const enemyHP = opts.enemyHP || 800; const first = opts.first !== false;
    const bonus = zero();
    const focus = deck.length ? pickFocus(deck, opts) : -1;
    const st = deck.map(({ card, talent }) => {
      const P = profile(card, talent);
      return {
        card, P, prec: 0, crit: P.critSelfStatic || 0, ratio: P.critRatioSelf || 0, base: 0,
        baseAb: card.ab.map(() => 0), countAct: card.ab.map(() => 0),
        cd: card.ab.map((ab) => Math.max(0, ab.cd - (first ? 0 : 1))), temporality: 0,
        used: card.ab.map(() => 0), lim: card.ab.map(usesOf), cost: card.ab.map(costOf), tgt: card.ab.map(targetOf),
        echo: card.ab.map((ab) => (ab.ech || 0) + (/Roulette/.test(P.talent?.n || '') ? 10 : 0)),
        dT: 0, hT: 0, taunt: 0, tauntTurns: 0, tauntBoost: 0,
        hpMax: card.hp, hp: card.hp, res: avgRes(card.res), alive: true, deathTurn: 0, taken: 0, healed: 0,
        imp: importance(P), phoenix: 0, cimetiere: 0,
      };
    });
    // PV, résistances et survie données par les talents et passifs
    st.forEach((s) => {
      const t = s.P.talent; const ids = s.card.sk.map((k) => k.id).concat(t && t.g ? [t.g] : []);
      if (ids.some((x) => /^Phoenix_R/.test(x))) s.phoenix = 50; else if (ids.some((x) => /^Phoenix_C/.test(x)) && !/Nouvelle vie/.test(t?.n || '')) s.phoenix = 25;
      if (/Nouvelle vie/.test(t?.n || '')) { s.phoenix = 25; } // Phénix ou Cimetière au hasard : on retient Phénix (cas le plus fréquent utile)
      if (ids.some((x) => /^Cimetiere_R/.test(x))) s.cimetiere = 5; else if (ids.some((x) => /^Cimetiere_C/.test(x))) s.cimetiere = 3;
      if (!t) return;
      for (const a of t.ac) {
        const [eff] = a; const v = avg(a);
        if (eff === 'AddCardHPMax' && !/meurt/.test(t.e)) s.hpMax += v;
        else if (eff === 'AddOppHPMax') st.forEach((o) => { if (o !== s) o.hpMax += v; });
        else if (eff === 'AddCardResistance' && v > 0 && !/meurt|subit/.test(t.e)) s.res += (/Tant que les PV/.test(t.e) ? 0.5 : 1) * v / ELS.length;
        else if (eff === 'AddOppCardResistance' && v > 0 && !/subit/.test(t.e)) st.forEach((o) => (o.res += v / ELS.length));
      }
    });
    st.forEach((s) => { s.hp = s.hpMax; });
    const pressure = opts.pressure || 0;
    let deaths = 0;
    const alive = () => st.filter((s) => s.alive);
    // Mort d'une carte : Phénix la relève une fois, sinon elle quitte la partie et déclenche les effets « quand une carte meurt »
    const kill = (s, t) => {
      if (s.phoenix) { s.hp = s.hpMax * s.phoenix / 100; s.phoenix = 0; return; }
      s.alive = false; s.hp = 0; s.deathTurn = t; s.taunt = 0; deaths++;
      st.forEach((o) => {
        if (!o.alive) return;
        if (o.cimetiere) ELS.forEach((e) => (bonus[e] += o.cimetiere));
        const tn = o.P.talent?.n || '';
        if (/Vitalité des Âmes/.test(tn)) { o.hpMax += 300; o.hp += 300; }
        if (/One man army/.test(tn)) o.base += 5;
        if (/Armure des Âmes/.test(tn)) o.res += 10;
      });
      if (/Héritage/.test(s.P.talent?.n || '')) sp += 50;
    };
    // Tour adverse : la moitié des dégâts frappe en zone, l'autre moitié vise la carte la plus rentable à tuer,
    // sauf si une Provocation la détourne.
    const enemyPhase = (t) => {
      if (!pressure) return;
      const al = alive(); if (!al.length) return;
      const E = refPressure(t) * pressure * (1 - Math.min(0.5, enemyPrecDown / 400));
      const tauntSum = al.reduce((x, s) => x + s.taunt, 0); const tShare = Math.min(1, tauntSum);
      const target = al.reduce((b, s) => (s.imp / (s.hp / Math.max(0.1, 1 - s.res / 100)) > b.imp / (b.hp / Math.max(0.1, 1 - b.res / 100)) ? s : b), al[0]);
      const dmg = new Map();
      al.forEach((s) => dmg.set(s, (E * 0.5) / al.length));
      if (tShare > 0) al.forEach((s) => dmg.set(s, dmg.get(s) + E * 0.5 * tShare * (s.taunt / Math.max(1, tauntSum))));
      dmg.set(target, dmg.get(target) + E * 0.5 * (1 - tShare));
      al.forEach((s) => { const d = dmg.get(s) * (1 - Math.min(RES_CAP, s.res) / 100); s.hp -= d; s.taken += d; if (s.hp <= 0) kill(s, t); });
      // chaleur : à partir du tour 20, dégâts bruts croissants sur toutes les cartes
      if (t >= HEAT_START) alive().forEach((s) => { const d = s.hpMax * HEAT_STEP * (t - HEAT_START + 1); s.hp -= d; s.taken += d; if (s.hp <= 0) kill(s, t); });
    };
    // Cibles choisies pour les effets monocibles : opts.targets['<carte>:<compétence>'] = index de l'alliée
    // (compétence = index, ou 'p' pour un passif). Par défaut : la carte « focus ».
    const targets = opts.targets || {};
    let curSingle = focus;
    const targetFor = (s, key) => { const v = targets[s.card.id + ':' + key]; const k = typeof v === 'string' ? st.findIndex((o) => o.card.id === v) : v; return k >= 0 && k < st.length ? k : focus; };
    // Temporalité (passif) : au début de la partie, -1 tour sur les recharges en cours de l'alliée choisie (une seule fois)
    st.forEach((s) => {
      const ids = s.card.sk.map((k) => k.id).concat(s.P.talent && s.P.talent.g ? [s.P.talent.g] : []);
      if (ids.some((x) => /^Temporality/.test(x))) { const o = st[targetFor(s, 'p')]; if (o) o.cd = o.cd.map((c) => Math.max(0, c - 1)); }
    });
    const add = (stat, scope, caster, v) => {
      if (!v) return;
      const al = st.filter((s) => s.alive);
      if (scope === 'self') caster[stat] += v;
      else if (scope === 'single') { const f = st[curSingle] && st[curSingle].alive ? st[curSingle] : al.reduce((b, s) => (!b || s.imp > b.imp ? s : b), null); if (f) f[stat] += v; }
      else if (scope === 'random') al.forEach((s) => (s[stat] += v / al.length));
      else al.forEach((s) => (s[stat] += v));
    };
    let resDown = 0, berserk = 0, sp = 0, enemyPrecDown = 0;
    st.forEach((s) => { ELS.forEach((e) => (bonus[e] += s.P.genStart[e])); berserk += s.P.berserk; sp += s.P.spStart; });
    const spOpening = first ? st.reduce((x, s) => x + s.card.sp, 0) : 0;
    sp += spOpening;
    const snapStats = () => st.map((s) => ({ prec: s.prec, crit: s.crit, ratio: s.ratio, base: s.base }));
    const startStats = snapStats();
    const perTurn = []; let sumD = 0, sumH = 0, sumF = 0;
    for (let t = 1; t <= T; t++) {
      let dT = 0, hT = 0, fT = 0, hDirect = 0;
      const before = { ...bonus }; const spBefore = sp; const sBefore = snapStats();
      // début du tour : les recharges baissent d'un cran (une recharge de 1 est donc prête à chaque tour),
      // les Provocations posées au tour précédent ont fait leur effet et disparaissent
      if (!first) enemyPhase(t); // en jouant second, l'adversaire frappe avant ton tour
      berserk = st.reduce((x, s) => x + (s.alive ? s.P.berserk : 0), 0);
      st.forEach((s) => {
        s.dT = 0; s.hT = 0;
        if (!s.alive) return;
        const ids = s.card.sk.map((k) => k.id).concat(s.P.talent?.g ? [s.P.talent.g] : []);
        if (ids.some((x) => /^Primitive heal/.test(x))) s.hp = Math.min(s.hpMax, s.hp + s.hpMax * 0.04);
        if (ids.some((x) => /^CoeurVital/.test(x))) { s.hpMax += 15; s.hp += 15; }
        if (ids.some((x) => /^CoeurResistance_C/.test(x))) st.forEach((o) => (o.res += 3));
        if (ids.some((x) => /^CoeurResistance_R/.test(x))) st.forEach((o) => (o.res += 6));
        if (t === 8 && /Life-8/.test(s.P.talent?.n || '')) { s.hpMax *= 2; s.hp *= 2; }
        s.cd = s.cd.map((c) => c - 1);
        if (s.tauntTurns > 0) { s.tauntTurns--; if (s.tauntTurns <= 0) s.taunt = 0; }
        if (/^Focus$/.test(s.P.talent?.n || '')) { s.taunt = 1 - (1 - s.taunt) * 0.75; s.tauntTurns = Math.max(s.tauntTurns, 1); }
      });
      // passifs et talents « par tour »
      st.forEach((s) => {
        if (!s.alive) return;
        s.card.sk.concat(s.P.talent && s.P.talent.g ? [{ id: s.P.talent.g }] : []).forEach((sk) => {
          const m = sk.id.match(/^Coeur(Feu|Eau|Terre|Nature|Ombre|Lumiere)_(C|R)$/);
          if (m) { const map = { Feu: 'fire', Eau: 'water', Terre: 'earth', Nature: 'nature', Ombre: 'shadow', Lumiere: 'light' }; bonus[map[m[1]]] += m[2] === 'R' ? 2 : 1; }
        });
        const tn = s.P.talent?.n || '';
        if (/Boule de Crit/.test(tn)) s.crit += 2;
        if (/Incisif/.test(tn)) { add('crit', 'team', s, 1); add('prec', 'team', s, 1); }
        if (/Affaiblissement/.test(tn)) resDown += 1;
        sp += s.P.spTurn + (s.P.spGrow || 0) * t;
      });
      // actions : chaque carte lance toutes ses compétences prêtes, dans l'ordre qu'un joueur choisirait :
      // 1) poser les Provocations, 2) les soutiens (bonus, boosts, briser une Provocation), 3) attaques et soins
      const phaseOf = (ab) => {
        if (/Applique Provocation/i.test(ab.e) && !ab.ac.some((a) => a[0] === 'RemoveTauntRunning') && !hits(ab)) return 0;
        if (!hits(ab)) return ab.ac.some((a) => a[0] === 'RemoveTauntRunning') ? (ab.ac.some((a) => a[0] === 'AddOppCardBaseDamage') ? 1 : 2) : 1;
        return 3;
      };
      for (const phase of [0, 1, 2, 3]) st.forEach((s) => {
        if (!s.alive) return;
        s.card.ab.forEach((ab, i) => {
          if (phaseOf(ab) !== phase) return;
          if (s.cd[i] > 0 || (s.lim[i] && s.used[i] >= s.lim[i])) return;
          const breaks = ab.ac.some((a) => a[0] === 'RemoveTauntRunning');
          const tauntSum = st.reduce((x, o) => x + (o.alive ? o.taunt : 0), 0);
          if (breaks && tauntSum < 0.01) return; // rien à briser : on garde la compétence
          const cost = s.cost[i];
          if (cost) {
            const els = Object.keys(cost).filter((k) => k !== 'hp');
            if (els.some((e) => bonus[e] < cost[e])) return; // pas assez de bonus : on attend
            els.forEach((e) => (bonus[e] -= cost[e]));
          }
          s.used[i]++;
          const opt = nOptions(ab); const tgt = s.tgt[i]; const scope = buffScope(tgt);
          curSingle = targetFor(s, i);
          const prec = Math.max(0, Math.min(100, (ab.p || 100) + s.prec)) / 100;
          const cc = Math.max(0, Math.min(100, ab.cc + s.crit)) / 100;
          const cm = ab.cm + s.ratio;
          const critF = 1 + cc * (cm - 1);
          const condF = onCrit(ab) ? cc : 1;
          const thisAttack = /de cette attaque/i.test(ab.e);
          // Briser une Provocation : le bonus va à la carte qui la porte (pondéré par la probabilité qu'elle la porte)
          const breakW = breaks ? st.map((o) => (o.alive ? o.taunt / Math.max(1, tauntSum) : 0) * prec) : null;
          if (breaks) st.forEach((o, k) => { o.taunt = Math.max(0, o.taunt - breakW[k]); });
          const dual = dualOf(ab);
          if (dual) { // une seule cible reçoit les dégâts ET le soin : attaque (adversaire) ou soin (alliée)
            const ad = ab.ac[dual.d], ah = ab.ac[dual.h];
            const mul = critF * prec * (1 + berserk / 100); const base = s.base + s.baseAb[i];
            const raw = (avg(ad) / opt + base) * (1 + 0.1 * (bonus[ad[4]] || 0) * (s.P.multiplicator ? 2 : 1)) * mul;
            const heal = (avg(ah) / opt + base) * (1 + 0.1 * (bonus[ah[4]] || 0) * (s.P.multiplicator ? 2 : 1)) * mul;
            const res = s.P.brut ? 0 : Math.max(-1, Math.min(RES_CAP / 100, enemyRes) - resDown / 100);
            const atkNet = raw * (1 - res) * (1 + s.P.aoe * 0.5) - heal;
            const al = alive(); const choice = targets[s.card.id + ':' + i];
            let ally = typeof choice === 'string' && choice[0] !== '!' ? st.find((o) => o.card.id === choice && o.alive) : null;
            const selfD = (o) => raw * (1 - Math.min(RES_CAP, o.res) / 100);
            const healNet = (o) => (o.hp <= selfD(o) ? -1e9 : Math.min(heal, o.hpMax - o.hp + selfD(o)) - selfD(o));
            if (!ally && choice !== '!atk') ally = al.reduce((b, o) => (!b || healNet(o) > healNet(b) ? o : b), null);
            const healMode = choice === '!heal' || (ally && choice && choice[0] !== '!') || (choice !== '!atk' && ally && pressure && healNet(ally) > atkNet);
            if (healMode && ally) { // soin net sur l'alliée (les dégâts d'eau s'appliquent directement à elle)
              const d = selfD(ally); ally.hp -= d; ally.taken += d; const x = Math.max(0, Math.min(heal, ally.hpMax - ally.hp)); ally.hp += x; ally.healed += x;
              hT += x - d; s.hT += x - d; hDirect += x - d; if (ally.hp <= 0) kill(ally, t);
            } else { const n = Math.max(0, atkNet); dT += n; s.dT += n; }
          }
          for (const a of ab.ac) {
            const [eff] = a; const v = avg(a) / opt; let el = a[4];
            if (dual && (a === ab.ac[dual.d] || a === ab.ac[dual.h])) continue;
            const pv = v * prec; // effet attendu, pondéré par la précision
            if (['damage', 'DamageAll', 'DamageWithCardElement', 'DamageCasterHP'].includes(eff)) {
              if (eff === 'DamageWithCardElement') el = s.card.el;
              const b = (bonus[el] || 0) * (s.P.multiplicator ? 2 : 1);
              const base = v + s.base + s.baseAb[i];
              const hit = base * (1 + 0.1 * b) * critF * prec * (1 + berserk / 100);
              const sp2 = dmgSplit(eff, tgt);
              const res = s.P.brut ? 0 : Math.max(-1, Math.min(RES_CAP / 100, enemyRes) - resDown / 100);
              const toEnemy = hit * sp2.enemy * (1 - res) * (1 + s.P.aoe * 0.5);
              dT += toEnemy; s.dT += toEnemy; fT += hit * sp2.ally;
              if (s.P.multicolor) ELS.forEach((e) => (bonus[e] += prec / Math.max(1, ab.ac.length)));
            } else if (eff === 'healTarget' || eff === 'healCaster') {
              const b = (bonus[el] || 0) * (s.P.multiplicator ? 2 : 1);
              const val = (v + s.base + s.baseAb[i]) * (1 + 0.1 * b) * critF * prec * (1 + berserk / 100) * (eff === 'healCaster' ? 1 : healMult(tgt));
              hT += val; s.hT += val;
            } else if (eff === 'DamageOpponentHPMAX') {
              const v2 = enemyHP * avg(a) / 100 * prec; dT += v2; s.dT += v2;
            } else if (eff === 'AddAllPlayerAttack') {
              if (el) bonus[el] += pv * condF; else ELS.forEach((e) => (bonus[e] += pv * condF));
            } else if (eff === 'AddAllPlayerAttackRandomTeam') ELS.forEach((e) => (bonus[e] += pv / 6));
            else if (eff === 'AddAllPlayerAttackWithCardType') bonus[s.card.el] += pv;
            else if (eff === 'AddAllPlayerAttackCountActivation1') { s.countAct[i]++; if (el) bonus[el] += s.countAct[i] * prec; }
            else if (eff === 'StealElement') { if (el) bonus[el] += pv; }
            else if (eff === 'AddCardBaseDamage') { if (thisAttack) s.baseAb[i] += pv; else s.base += pv; }
            else if (eff === 'AddAbilityBaseDamage') s.baseAb[i] += pv;
            else if (eff === 'AddOppCardBaseDamage') {
              if (breaks) st.forEach((o, k) => { o.base += v * breakW[k]; o.tauntBoost += v * breakW[k]; });
              else add('base', scope, s, pv);
            }
            else if (eff === 'AddAllPlayerCritick') add('crit', 'team', s, pv * condF);
            else if (eff === 'AddCardCriticChance') add('crit', 'self', s, pv * condF);
            else if (eff === 'AddOppCardCriticChance') add('crit', scope, s, pv * condF);
            else if (eff === 'AddAllPlayerMiss') add('prec', 'team', s, -pv);
            else if (eff === 'AddCardMiss') add('prec', 'self', s, -pv);
            else if (eff === 'AddOppCardMiss') { if (v > 0) enemyPrecDown += pv * (tgt === 'allEnemies' ? 4 : 1); else add('prec', scope, s, -pv); }
            else if (eff === 'AddAllPlayerHPMax') alive().forEach((o) => { o.hpMax += pv; o.hp += pv; });
            else if (eff === 'AddOppHPMax' && breaks) st.forEach((o, k) => { const x = v * breakW[k]; o.hpMax += x; o.hp += x; });
            else if (eff === 'AddCardCriticRatio') add('ratio', 'self', s, pv);
            else if (eff === 'AddOppCardCriticRatio') add('ratio', scope, s, pv);
            else if (eff === 'AddCooldown' && v < 0) { // Temporalité appliquée par une compétence
              const n = Math.abs(v) * prec;
              const tg = tgt === 'allAllies' || /toutes les cartes alli/i.test(ab.e) ? st.filter((o) => o.alive) : /carte cibl[ée]e/i.test(ab.e) ? [] : [st[curSingle]].filter(Boolean);
              tg.forEach((o) => { o.cd = o.cd.map((c) => c - n); }); // Temporalité : -n tours sur les recharges en cours, une fois
            }
          }
          // Poser une Provocation (sur le lanceur, ou sur une alliée au hasard)
          if (/Applique Provocation/i.test(ab.e) && !breaks) {
            const dur = +((ab.e.match(/pendant (\d+) tours/i) || [])[1] || 1);
            if (/al[ée]atoirement [àa] une carte alli/i.test(ab.e)) { const al = alive(); al.forEach((o) => { o.taunt = 1 - (1 - o.taunt) * (1 - prec / al.length); o.tauntTurns = Math.max(o.tauntTurns, dur); }); }
            else { s.taunt = 1 - (1 - s.taunt) * (1 - prec); s.tauntTurns = Math.max(s.tauntTurns, dur); }
          }
          if (s.card.sk.some((k) => /^Taunt/.test(k.id)) && hits(ab)) { s.taunt = 1; s.tauntTurns = Math.max(s.tauntTurns, 1); }
          s.cd[i] = Math.max(1, ab.cd - s.temporality) * (1 - Math.min(90, s.echo[i]) / 100);
        });
      });
      // les soins vont aux cartes en vie qui ont perdu le plus de PV (le surplus est perdu)
      if (pressure && hT - hDirect > 0) {
        let pool = hT - hDirect;
        for (let k = 0; k < 4 && pool > 0.01; k++) {
          const al = alive().filter((s) => s.hp < s.hpMax).sort((a, b) => (a.hp / a.hpMax) - (b.hp / b.hpMax));
          if (!al.length) break;
          const s = al[0]; const x = Math.min(pool, s.hpMax - s.hp); s.hp += x; s.healed += x; pool -= x;
        }
      }
      if (pressure && fT > 0) { const al = alive(); al.forEach((s) => { s.hp -= fT / al.length; s.taken += fT / al.length; if (s.hp <= 0) kill(s, t); }); }
      if (first) enemyPhase(t);
      sumD += dT; sumH += hT; sumF += fT;
      const gen = {}; [...ELS, 'divine'].forEach((e) => (gen[e] = bonus[e] - before[e]));
      const now = snapStats();
      const gains = now.map((x, i) => ({ prec: x.prec - sBefore[i].prec, crit: x.crit - sBefore[i].crit, ratio: x.ratio - sBefore[i].ratio, base: x.base - sBefore[i].base }));
      perTurn.push({ t, dmg: dT, heal: hT, friendly: fT, cumDmg: sumD, cumHeal: sumH, bonus: { ...bonus }, gen, sp, spGain: sp - spBefore,
        cards: st.map((s) => ({ dmg: s.dT, heal: s.hT, hp: Math.max(0, s.hp), hpMax: s.hpMax, alive: s.alive })), stats: now, gains, enemyPrecDown,
        aliveCount: st.filter((s) => s.alive).length, deaths });
    }
    const n = perTurn.length || 1;
    const startBonus = zero();
    st.forEach((s) => ELS.forEach((e) => (startBonus[e] += s.P.genStart[e])));
    const last = perTurn[perTurn.length - 1];
    const mean = (f) => perTurn.reduce((x, p) => x + f(p), 0) / n;
    perTurn.focus = focus;
    perTurn.pressure = pressure;
    perTurn.deathTurns = st.map((s) => s.deathTurn);
    perTurn.target = st.map((s) => s.imp);
    perTurn.spOpening = spOpening;
    perTurn.avg = {
      dmg: sumD / n, heal: sumH / n, friendly: sumF / n,
      gen: Object.fromEntries(ELS.map((e) => [e, mean((p) => p.gen[e])])),
      start: startBonus, sp: mean((p) => p.spGain),
      cards: st.map((s, i) => ({ dmg: mean((p) => p.cards[i].dmg), heal: mean((p) => p.cards[i].heal) })),
      // boosts reçus en moyenne par tour, carte par carte (équipe + monocible + sur soi)
      gains: st.map((s, i) => ({ prec: mean((p) => p.gains[i].prec), crit: mean((p) => p.gains[i].crit), ratio: mean((p) => p.gains[i].ratio), base: mean((p) => p.gains[i].base) })),
      enemyPrecDown: last ? last.enemyPrecDown / n : 0,
      alive: mean((p) => p.aliveCount),
      healEff: st.reduce((x, s) => x + s.healed, 0) / n,
    };
    // précision et critique effectives de chaque compétence, au début et à la fin de la simulation
    perTurn.abilityStats = st.map((s, i) => s.card.ab.map((ab) => ({
      n: ab.n, p0: Math.min(100, (ab.p || 100) + startStats[i].prec), p1: Math.min(100, (ab.p || 100) + (last ? last.stats[i].prec : 0)),
      c0: Math.min(100, ab.cc + startStats[i].crit), c1: Math.min(100, ab.cc + (last ? last.stats[i].crit : 0)),
      m0: ab.cm + startStats[i].ratio, m1: ab.cm + (last ? last.stats[i].ratio : 0), cd: ab.cd,
    })));
    return perTurn;
  }

  // Valeur propre d'un talent que la simulation ne mesure pas (PV, résistances, économie, survie).
  // Toujours positive : un talent débloqué vaut mieux que pas de talent.
  function talentIntrinsic(card, slot, survivalSimulated) {
    const t = card.ta.find((x) => x.s === slot); if (!t) return 0;
    let v = 3;
    for (const a of t.ac) {
      const [eff] = a; const x = avg(a);
      if (!survivalSimulated) {
        if (eff === 'AddCardHPMax') v += x / 40;
        else if (eff === 'AddOppHPMax') v += (x * 3) / 40;
        else if (eff === 'AddCardResistance' && x > 0) v += x / 6 * 0.35;
        else if (eff === 'AddOppCardResistance' && x > 0) v += x / 6 * 1.2;
      }
      if (eff === 'AddSpamton' && x > 0) v += x * 0.08;
      else if (eff === 'AddSpamtonGenerationCaster') v += x * 1.2;
      else if (eff === 'AddLuck') v += x * 2;
    }
    const simulatedSurvival = /Phénix|Life-8|Nouvelle vie|Résilience|Vitalité des Âmes|Armure des Âmes/i;
    if (/Reset ultime|Revitalisation|Sursaut Vital|Chance Vitale|Transition|Immunité-8|Contre|Cœur d’acier/i.test(t.n) || (!survivalSimulated && simulatedSurvival.test(t.n))) v += 6;
    if (/Dette/.test(t.n)) v -= 1;
    return Math.max(0.5, v);
  }

  // Score d'un deck : production simulée + synergies non simulées + PV + talents
  function deckValue(deck, opts) {
    const S = simulate(deck, opts);
    const rep = deckReport(deck);
    const nonSim = rep.links.filter((l) => !['élément', 'base', 'crit', 'précision', 'berserk'].includes(l.k)).reduce((s, l) => s + l.s, 0);
    const surv = !!opts.pressure;
    const tal = deck.reduce((s, d) => s + talentIntrinsic(d.card, d.talent, surv), 0);
    if (!surv) {
      const hp = deck.reduce((s, d) => s + d.card.hp, 0);
      return S.avg.dmg + 0.5 * S.avg.heal - 0.7 * S.avg.friendly + nonSim + hp / 400 + tal;
    }
    // avec adversaire : la production tient compte des morts ; rester en vie vaut en plus par lui-même
    return S.avg.dmg + 0.3 * S.avg.healEff - 0.7 * S.avg.friendly + nonSim + 15 * S.avg.alive + tal;
  }

  // Recherche par faisceau du meilleur deck de 4 dans un ensemble de cartes
  // talentsOf(card) -> liste des talents utilisables (0 = aucun)
  function optimize(pool, talentsOf, opts, width = 12) {
    let beams = [{ deck: [], v: 0 }];
    for (let k = 0; k < 4; k++) {
      const next = []; const seen = new Set();
      for (const b of beams) {
        const used = new Set(b.deck.map((d) => d.card.id));
        for (const card of pool) {
          if (used.has(card.id)) continue;
          const key = [...used, card.id].sort().join('|');
          if (seen.has(key)) continue; seen.add(key);
          let best = null;
          for (const t of talentsOf(card)) {
            const deck = b.deck.concat([{ card, talent: t }]);
            const v = deckValue(deck, { ...opts, focus: -1 });
            if (!best || v > best.v) best = { deck, v };
          }
          next.push(best);
        }
      }
      next.sort((a, b) => b.v - a.v);
      beams = next.slice(0, width);
      if (!beams.length) break;
    }
    return beams;
  }

  // ---------- Synergies entre deux cartes ----------
  const EL_FR = { fire: 'Feu', water: 'Eau', earth: 'Terre', nature: 'Nature', light: 'Lumière', shadow: 'Ombre', divine: 'Éther' };
  function pairSynergy(A, B) {
    // A apporte à B
    const out = [];
    let elScore = 0; const els = [];
    ELS.forEach((e) => {
      const g = A.gen[e] + A.genStart[e] / 8; const u = B.use[e];
      if (g > 0.05 && u > 0.5) { const s = g * u * (B.multiplicator ? 2 : 1); elScore += s; els.push(EL_FR[e]); }
    });
    if (elScore > 0) out.push({ k: 'élément', s: elScore * 0.6, t: `génère du bonus ${els.join('/')} utilisé par ses attaques` });
    if (A.baseTeam > 0 && B.hits > 0) out.push({ k: 'base', s: A.baseTeam * B.hits * 6, t: `augmente les valeurs de base de l'équipe (${B.hits.toFixed(1)} coups/tour à booster)` });
    if (A.critTeam > 0 && B.critHits > 0) out.push({ k: 'crit', s: A.critTeam * B.critHits * 1.5, t: `ajoute du critique à l'équipe` });
    if (A.critRatio > 0 && B.critHits > 0) out.push({ k: 'crit', s: A.critRatio * B.critHits * 8, t: `augmente les dégâts critiques` });
    if (A.precTeam > 0 && B.hits > 0) out.push({ k: 'précision', s: A.precTeam * B.hits * 0.6 * (B.lowPrec ? 2 : 1), t: `ajoute de la précision à toute l'équipe (+${A.precTeam.toFixed(1)} %/tour)` });
    if (A.precSingle > 0 && B.hits > 0) out.push({ k: 'précision', s: A.precSingle * B.hits * 0.6 * (B.lowPrec ? 2 : 1), t: `peut cibler cette carte pour +${A.precSingle.toFixed(1)} % de précision par tour` });
    if (A.critSingle > 0 && B.critHits > 0) out.push({ k: 'crit', s: A.critSingle * B.critHits * 1.5, t: `peut cibler cette carte pour +${A.critSingle.toFixed(1)} % de critique par tour` });
    if (A.ratioSingle > 0 && B.critHits > 0) out.push({ k: 'crit', s: A.ratioSingle * B.critHits * 8, t: `peut augmenter ses dégâts critiques (+${A.ratioSingle.toFixed(2)} par tour)` });
    if (A.tauntBreakBase > 0 && B.hits > 0) {
      // le boost va à la carte qui porte la Provocation : sûr si B se la pose elle-même, 1 chance sur 4 si A la pose au hasard
      const pB = B.tauntSelf > 0 ? Math.min(1, B.tauntSelf * 1.5) : A.tauntRandomAlly > 0 ? 0.25 : 0;
      if (pB > 0) out.push({ k: 'provocation', s: A.tauntBreakBase * pB * B.hits * 6, t: B.tauntSelf > 0
        ? `brise la Provocation que cette carte se pose pour lui donner +${A.tauntBreakBase.toFixed(1)} de valeur de base`
        : `brise sa propre Provocation posée au hasard : ce boost n'atterrit sur cette carte qu'une fois sur 4` });
    }
    if (A.baseSingle > 0 && B.hits > 0) out.push({ k: 'base', s: A.baseSingle * B.hits * 6, t: `peut augmenter ses valeurs de base (+${A.baseSingle.toFixed(1)} par tour)` });
    if (A.berserk > 0) out.push({ k: 'berserk', s: A.berserk * (B.dmg + B.heal) / 100 * 0.8, t: `Berserk : +${A.berserk} % dégâts et soins` });
    if (A.taunt > 0 && B.hp < 700 && B.dmg > 15) out.push({ k: 'protection', s: A.taunt * 6, t: `peut attirer les attaques (Provocation) et protéger cette carte fragile` });
    if (A.heal > 5 && B.hp >= 900) out.push({ k: 'soin', s: A.heal * 0.08, t: `soigne une carte qui a beaucoup de PV à rentabiliser` });
    if ((A.hpTeam || A.hpTeamStatic) && B.hp) out.push({ k: 'PV', s: ((A.hpTeamStatic || 0) / 150 + A.hpTeam / 30) * 2, t: `augmente les PV max des alliés` });
    if (A.deathEnabler.length && B.deathPayoff.length) out.push({ k: 'mort', s: 5 * A.deathEnabler.length, t: `provoque des morts (${A.deathEnabler.join(', ')}) qui déclenchent ${B.deathPayoff.join(', ')}` });
    if (A.temporality > 0 && B.dmg > 20) out.push({ k: 'recharge', s: A.temporality * 4, t: `réduit les temps de recharge` });
    return out;
  }

  function deckReport(deck) {
    const profs = deck.map(({ card, talent }) => ({ card, P: profile(card, talent) }));
    const links = [];
    for (const a of profs) for (const b of profs) {
      if (a === b) continue;
      for (const l of pairSynergy(a.P, b.P)) links.push({ from: a.card, to: b.card, ...l });
    }
    // couverture élémentaire : part de l'usage couverte par la génération d'équipe
    const gen = zero(), use = zero();
    profs.forEach(({ P }) => ELS.forEach((e) => { gen[e] += P.gen[e] + P.genStart[e] / 8; use[e] += P.use[e]; }));
    const totalUse = ELS.reduce((s, e) => s + use[e], 0) || 1;
    const covered = ELS.reduce((s, e) => s + (gen[e] > 0.05 ? use[e] : 0), 0);
    const focus = covered / totalUse;
    const warnings = [];
    ELS.forEach((e) => { if (use[e] / totalUse > 0.2 && gen[e] <= 0.05) warnings.push(`Beaucoup de dégâts ${EL_FR[e]} mais aucune génération de bonus ${EL_FR[e]}.`); });
    ELS.forEach((e) => { if (gen[e] > 0.5 && use[e] < 1) warnings.push(`Bonus ${EL_FR[e]} généré mais presque pas utilisé.`); });
    if (profs.some(({ P }) => P.deathPayoff.length) && !profs.some(({ P }) => P.deathEnabler.length)) warnings.push('Des effets « quand une carte meurt » sans carte qui provoque ou survit aux morts : ils dépendront des morts naturelles.');
    if (!profs.some(({ P }) => P.taunt > 0) && profs.filter(({ card }) => card.hp < 650).length >= 2) warnings.push('Plusieurs cartes fragiles sans Provocation pour les protéger.');
    profs.forEach(({ card, P }) => { if (P.friendly > 1) warnings.push(`${card.n} cible aléatoirement tout le terrain : environ la moitié de ses coups touchent tes propres cartes.`); });
    profs.forEach(({ card }) => card.ab.forEach((ab) => {
      const du = dualOf(ab); if (!du) return; const ed = ab.ac[du.d][4], eh = ab.ac[du.h][4];
      const gd = gen[ed] || 0, gh = gen[eh] || 0;
      const mode = gh > gd + 0.3 ? `plutôt en soin (bonus ${EL_FR[eh]} > ${EL_FR[ed]})` : gd > gh + 0.3 ? `plutôt en attaque (bonus ${EL_FR[ed]} > ${EL_FR[eh]})` : `sans orientation claire : ton bonus ${EL_FR[ed]} et ton bonus ${EL_FR[eh]} s'annulent`;
      warnings.push(`${card.n} : « ${ab.n} » inflige ${EL_FR[ed]} ET soigne ${EL_FR[eh]} la même cible. Pour attaquer, monte le bonus ${EL_FR[ed]} sans bonus ${EL_FR[eh]} ; pour soigner, l'inverse. Ce deck la joue ${mode}.`);
    }));
    profs.forEach(({ card }) => { card.ab.forEach((ab) => { if ((ab.p || 100) <= 50 && hits(ab)) warnings.push(`${card.n} : « ${ab.n} » n'a que ${ab.p} % de précision. Les boosts de précision comptent double pour elle.`); }); });
    const totalScore = links.reduce((s, l) => s + l.s, 0);
    return { profs, links, gen, use, focus, warnings, totalScore };
  }

  // Classe les cartes candidates (avec leur meilleur talent) pour un deck donné
  // Classe les cartes candidates (avec leur meilleur talent utilisable) pour un deck donné.
  // gain = hausse de la valeur du deck (production simulée + synergies non simulées)
  function suggest(deck, cards, talentsOf, opts) {
    const inDeck = new Set(deck.map((d) => d.card.id));
    const base = deck.length ? deckValue(deck, { ...opts, focus: -1 }) : 0;
    const baseSim = deck.length ? simulate(deck, { ...opts, focus: -1 }).avg : { dmg: 0, heal: 0 };
    const res = [];
    for (const card of cards) {
      if (inDeck.has(card.id)) continue;
      let best = null;
      for (const t of talentsOf(card)) {
        const d2 = deck.concat([{ card, talent: t }]);
        const gain = deckValue(d2, { ...opts, focus: -1 }) - base;
        if (!best || gain > best.gain) best = { card, talent: t, gain };
      }
      const d2 = deck.concat([{ card, talent: best.talent }]);
      const r = deckReport(d2); const S = simulate(d2, { ...opts, focus: -1 }).avg;
      best.links = r.links.filter((l) => l.from === card || l.to === card);
      best.dDmg = S.dmg - baseSim.dmg; best.dHeal = S.heal - baseSim.heal;
      res.push(best);
    }
    return res.sort((a, b) => b.gain - a.gain);
  }

  // Meilleur talent utilisable pour une carte déjà dans le deck
  function bestTalent(deck, idx, talentsOf, opts) {
    let best = null;
    for (const t of talentsOf(deck[idx].card)) {
      const d2 = deck.map((x, i) => (i === idx ? { ...x, talent: t } : x));
      const v = deckValue(d2, opts);
      if (!best || v > best.v + 1e-9) best = { slot: t, v };
    }
    return best;
  }

  root.SpamEngine = { RES_CAP, HEAT_START, HEAT_STEP, ELS, EL_FR, profile, simulate, dualOf, pairSynergy, deckReport, suggest, bestTalent, optimize, deckValue, talentIntrinsic, targetOf, nOptions,
    _int: { avg, zero, costOf, usesOf, targetOf, buffScope, onCrit, hits, nOptions, avgRes, importance, HIT_EFFECTS, dualOf } };
})(typeof window !== 'undefined' ? window : globalThis);
