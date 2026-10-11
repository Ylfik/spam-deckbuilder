// Lecture en direct du Player.log de SPAM : chaque ligne utile devient un événement.
// Ce que le jeu écrit pendant une partie (vérifié sur un vrai Player.log, client 1.22) :
//   OnMatchStarted : [{...}]              -> adversaire (pseudo, rang, étoiles)
//   Game launched match-X serveur Mode    -> identifiant et mode de la partie
//   MsgAfterConnected ... player_id=N     -> mon siège (0 ou 1)
//   [BoardCardCtrl] ... tox: UID          -> un Tox que J'AI acheté (l'UID revient dans la réponse d'achat)
//   OnInGameShopBuyItemResponse: card=GUID, modificatorUID=UID -> une carte reçoit un Tox (moi ou l'adversaire)
//   Focusing card: Nom                    -> carte survolée
//   [DmgPreview] ... GUID (uid), PV a/b, joueur p, case c, ... tour n
//   OnGameEnd puis {"state":"Winner"|"Loser",...}
//   Sending decks to server: {...}        -> mes decks
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RX = {
  matchStarted: /OnMatchStarted : (\[.*\])\s*$/,
  launched: /Game launched (match-\d+) \S+ (\w+)/,
  seat: /MsgAfterConnected: success=True player_id=(\d)/,
  myTox: new RegExp(`\\[BoardCardCtrl\\].*? tox: (${GUID})`),
  buy: new RegExp(`OnInGameShopBuyItemResponse: card=(${GUID}), modificatorUID=(${GUID})?`),
  focus: /Focusing card: (.+?)\s*$/,
  dmg: new RegExp(`\\[DmgPreview\\].*?(${GUID}) \\((\\w+)\\), PV (-?\\d+)/(\\d+), joueur (\\d), case (\\d+).*?tour (\\d+)`),
  gameStart: /\[GameClient\].*OnGameStart/,
  gameEnd: /\[GameClient\].*OnGameEnd/,
  result: /"state":"(Winner|Loser|Draw)"/,
  resign: /Client resign/,
  saved: /\[Replay\].*?(match-\d+)/,
  decks: /Sending decks to server: (\{.*\})\s*$/,
};
const norm = (s) => s.toLowerCase().normalize('NFC').replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();
function parseLine(line) {
  let m;
  if ((m = RX.myTox.exec(line))) return { k: 'myTox', uid: m[1] };
  if ((m = RX.buy.exec(line))) return { k: 'buy', card: m[1], uid: m[2] || null };
  if ((m = RX.focus.exec(line))) return { k: 'focus', name: m[1] };
  if ((m = RX.dmg.exec(line))) return { k: 'dmg', card: m[1], cuid: m[2], hp: +m[3], hpMax: +m[4], player: +m[5], slot: +m[6], turn: +m[7] };
  if ((m = RX.matchStarted.exec(line))) { try { const o = JSON.parse(m[1])[0]; return { k: 'match', id: o.matchId, opponent: o.opponent || {}, me: o.me || {} }; } catch (e) { return null; } }
  if ((m = RX.launched.exec(line))) return { k: 'launched', id: m[1], mode: m[2] };
  if ((m = RX.seat.exec(line))) return { k: 'seat', seat: +m[1] };
  if (RX.gameStart.test(line)) return { k: 'start' };
  if (RX.gameEnd.test(line)) return { k: 'end' };
  if ((m = RX.result.exec(line))) return { k: 'result', state: m[1] };
  if (RX.resign.test(line)) return { k: 'resign' };
  if ((m = RX.saved.exec(line))) return { k: 'saved', id: m[1] };
  if ((m = RX.decks.exec(line))) { try { return { k: 'decks', data: JSON.parse(m[1]) }; } catch (e) { return null; } }
  return null;
}

// État d'une partie reconstruit à partir des événements.
// guidToId : GUID -> identifiant de carte ; nameToId : nom affiché -> identifiant
class MatchState {
  constructor(lookup) { this.L = lookup; this.decks = {}; this.lastDeck = null; this.reset(); }
  reset() {
    this.id = null; this.mode = null; this.opponent = null; this.seat = null; this.live = false; this.result = null;
    this.myToxes = new Map(); this.buys = []; this.mine = new Map(); this.opp = new Map(); this.turn = 0; this.hp = {};
  }
  // carte vue : côté connu (mine/opp) ou à départager
  see(id, side, why) {
    if (!id) return;
    if (side === 'mine') { if (!this.mine.has(id)) this.mine.set(id, { id, why }); return; }
    if (side === 'opp') { if (!this.opp.has(id)) this.opp.set(id, { id, why }); return; }
  }
  myDeckIds() { return this.lastDeck ? this.lastDeck.cards.map((c) => this.L.guid[c.id]).filter(Boolean) : []; }
  apply(ev) {
    if (!ev) return false;
    switch (ev.k) {
      case 'decks': {
        for (const d of [...(ev.data.added || []), ...(ev.data.updated || [])]) { this.decks[d.id] = d; this.lastDeck = d; }
        for (const d of ev.data.removed || []) delete this.decks[d.id || d];
        return true;
      }
      case 'match': this.reset(); this.id = ev.id; this.opponent = ev.opponent; this.live = true; return true;
      case 'launched': if (this.id !== ev.id) { this.reset(); this.id = ev.id; } this.mode = ev.mode; this.live = true; return true;
      case 'seat': this.seat = ev.seat; return true;
      case 'start': this.live = true; return true;
      // l'UID est celui du type de Tox (il revient d'une partie à l'autre) : chaque ligne « tox: » de mon client
      // est consommée par la réponse d'achat suivante qui porte le même UID ; une réponse sans ligne en attente vient de l'adversaire
      case 'myTox': this.myToxes.set(ev.uid, (this.myToxes.get(ev.uid) || 0) + 1); return false;
      case 'buy': {
        if (!this.live || !ev.uid) return false; // sans Tox : effet de jeu, pas un achat (ex. carte invoquée)
        const id = this.L.guid[ev.card]; const n = this.myToxes.get(ev.uid) || 0;
        if (n > 0) { this.myToxes.set(ev.uid, n - 1); this.see(id, 'mine', 'achat'); } else this.see(id, 'opp', 'achat');
        this.buys.push({ id, mine: n > 0 });
        return true;
      }
      case 'focus': {
        if (!this.live) return false;
        const id = this.L.name[norm(ev.name)]; if (!id) return false;
        if (this.mine.has(id) || this.opp.has(id)) return false;
        // carte survolée : à moi si elle est dans mon deck et que je n'ai pas encore mes 4 cartes, sinon à l'adversaire
        const mineSlots = this.snapshot().mine;
        this.see(id, mineSlots.includes(id) && this.mine.size < 4 ? 'mine' : 'opp', 'survol'); return true;
      }
      case 'dmg': {
        const id = this.L.guid[ev.card]; if (this.seat == null) return false;
        this.see(id, ev.player === this.seat ? 'mine' : 'opp', 'plateau');
        this.hp[id] = { hp: ev.hp, hpMax: ev.hpMax }; this.turn = Math.max(this.turn, ev.turn); return true;
      }
      case 'end': this.live = false; return true;
      case 'resign': return false;
      case 'result': if (this.id && !this.result) { this.result = ev.state; return true; } return false;
      case 'saved': return true;
    }
    return false;
  }
  snapshot() {
    const deck = this.myDeckIds();
    const mine = [...this.mine.keys()];
    for (const id of deck) if (mine.length < 4 && !mine.includes(id)) mine.push(id);
    const opp = [...this.opp.keys()].slice(0, 4);
    return { id: this.id, mode: this.mode, live: this.live, result: this.result, seat: this.seat, turn: this.turn,
      opponent: this.opponent ? { name: this.opponent.username, rank: this.opponent.rank, stars: this.opponent.stars } : null,
      mine: mine.slice(0, 4), minePinned: [...this.mine.keys()], opp, hp: this.hp };
  }
}
module.exports = { parseLine, MatchState, RX, norm };
