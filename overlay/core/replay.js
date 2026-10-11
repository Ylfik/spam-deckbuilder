// Lecture des replays SPAM (.srpl) : gzip -> en-tête JSON -> messages horodatés.
// Fonctionne dans le navigateur (DecompressionStream) et dans Node (zlib).
// Types de messages repérés (déduits des fichiers, pas d'une documentation officielle) :
//   2003 offres de boutique (3 Tox) · 2021 offres après rafraîchissement · 2020 achat
//   2201 chance et Spamton d'un joueur · 2206 résolution d'une compétence (drapeaux « Crit », « Miss »)
//   2100/2101 début/fin d'une compétence · 2207/2000/2004/2015/2204 état des cartes
(function (root) {
  const dec = new TextDecoder('utf-8'); const dec16 = new TextDecoder('utf-16le');
  function varint(b, i) { let r = 0, sh = 0; for (;;) { const x = b[i++]; r |= (x & 0x7f) << sh; sh += 7; if (x < 0x80) return [r, i]; } }
  function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
  function f32(b, i) { return new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true); }
  // chaînes UTF-16 préfixées par un entier 32 bits (identifiants de cartes, noms de compétences, Tox)
  function u16strs(p, from = 2) {
    const out = []; let i = from;
    while (i + 4 <= p.length) {
      const n = u32(p, i);
      if (n >= 3 && n <= 64 && i + 4 + 2 * n <= p.length) {
        const s = dec16.decode(p.subarray(i + 4, i + 4 + 2 * n));
        let ok = true; for (const c of s) { const k = c.charCodeAt(0); if (k < 32 || k > 0x2000) { ok = false; break; } }
        if (ok) { out.push({ at: i, s }); i += 4 + 2 * n; continue; }
      }
      i++;
    }
    return out;
  }
  function parse(bytes) {
    const b = bytes; if (dec.decode(b.subarray(0, 4)) !== 'SRPL') throw new Error('pas un replay SPAM');
    let [L, i] = varint(b, 8); const header = JSON.parse(dec.decode(b.subarray(i, i + L))); i += L;
    const cnt = u32(b, i); i += 4; const msgs = [];
    for (let k = 0; k < cnt && i + 8 <= b.length; k++) { const t = u32(b, i), ln = u32(b, i + 4); i += 8; msgs.push({ t, type: b[i] | (b[i + 1] << 8), p: b.subarray(i, i + ln) }); i += ln; }
    return { header, msgs };
  }
  // cartes sur le plateau : identifiant de carte (GUID du Spamdex) -> uid de la partie, joueur, emplacement
  function boardCards(msgs) {
    const map = new Map();
    for (const m of msgs) {
      if (![2207, 2000, 2004, 2015, 2204].includes(m.type)) continue;
      const p = m.p;
      for (let i = 0; i + 40 < p.length; i++) {
        if (p[i] !== 0x4a || p[i + 9] !== 0x2d || p[i + 14] !== 0x2d) continue; // 'J' + GUID 36 caractères
        const guid = dec.decode(p.subarray(i + 1, i + 37));
        let j = i + 37; const ul = (p[j] >> 1) - 1; // longueur codée (n + 1) × 2 if (ul < 6 || ul > 20) continue;
        const uid = dec.decode(p.subarray(j + 1, j + 1 + ul)); j += 1 + ul;
        if (!/^[A-Za-z0-9]+$/.test(uid)) continue;
        j += 1; const sl = (p[j] >> 1) - 1; const style = dec.decode(p.subarray(j + 1, j + 1 + sl));
        if (!style.startsWith('cardstyle')) continue;
        j += 1 + sl; const slot = p[j + 1] >> 1; const player = p[j + 3] >> 1;
        if (!map.has(uid)) map.set(uid, { guid, uid, player, slot });
      }
    }
    return [...map.values()];
  }
  function analyse(rep) {
    const { header, msgs } = rep; const me = header.Seat;
    const cards = boardCards(msgs); const byUid = new Map(cards.map((c) => [c.uid, c]));
    const shops = [], buys = [], casts = [], luck = {}, timeline = [];
    for (const m of msgs) {
      if (m.type === 2201 && m.p.length >= 14) { const pl = u32(m.p, 2); luck[pl] = f32(m.p, 6); }
      else if (m.type === 2003 || m.type === 2021) {
        const ss = u16strs(m.p).map((x) => x.s); const pl = u32(m.p, 2);
        const offers = ss.filter((s, k) => k % 2 === 1 && /_[CREL]$/.test(s));
        if (!offers.length) continue;
        const l = m.type === 2003 ? f32(m.p, 14) : luck[pl];
        shops.push({ player: pl, mine: pl === me, luck: Math.round(l || 0), reroll: m.type === 2021, offers });
      } else if (m.type === 2020) {
        const ss = u16strs(m.p).map((x) => x.s); const c = byUid.get(ss[0]);
        buys.push({ player: c ? c.player : u32(m.p, 2), card: c ? c.guid : null, tox: ss[1] });
      } else if (m.type === 2206) {
        const ss = u16strs(m.p).map((x) => x.s); if (ss.length < 2) continue;
        const c = byUid.get(ss[0]); if (!c) continue;
        casts.push({ player: c.player, mine: c.player === me, card: c.guid, ability: ss[1], crit: ss.filter((s) => s === 'Crit').length, miss: ss.filter((s) => s === 'Miss').length, t: m.t });
      }
    }
    const myCards = cards.filter((c) => c.player === me).sort((a, b) => b.slot - a.slot).map((c) => c.guid);
    const oppCards = cards.filter((c) => c.player !== me).sort((a, b) => b.slot - a.slot).map((c) => c.guid);
    return {
      uid: header.GameUid, version: header.AppVersion, start: header.StartUtc, durationMs: header.DurationMs, turns: header.TurnCount,
      mode: header.GameMode, opponent: header.OpponentName, opponentIsAi: header.OpponentIsAi,
      result: header.IsDraw ? 'nul' : header.WinnerId === header.AccountId ? 'victoire' : 'défaite',
      myCards: myCards.length === 4 ? myCards : header.MyCards, oppCards: oppCards.length === 4 ? oppCards : header.OpponentCards,
      shops, buys, casts,
    };
  }
  async function gunzip(buf) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip'); const s = new Blob([buf]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(s).arrayBuffer());
    }
    return new Uint8Array(require('zlib').gunzipSync(Buffer.from(buf)));
  }
  async function readReplay(buf) { return analyse(parse(await gunzip(buf))); }
  root.SpamReplay = { readReplay, parse, analyse, boardCards, u16strs };
})(typeof window !== 'undefined' ? window : globalThis);
