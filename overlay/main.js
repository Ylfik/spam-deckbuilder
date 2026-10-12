// Overlay SPAM : calque transparent au-dessus du jeu (Windows, Steam).
// Lit le Player.log en direct (cartes, adversaire, siège) et les replays de fin de partie (boutique, critiques).
const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, screen, shell, dialog, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { parseLine, MatchState, norm } = require('./src/logparser.js');
const stats = require('./src/stats.js');
const V = require('./src/vision.js');
const OCR = require('./src/ocr.js');
require('./core/engine.js'); require('./core/duel.js');

const CORE = path.join(__dirname, 'core');
const CARDS = JSON.parse(fs.readFileSync(path.join(CORE, 'cards.json'), 'utf8'));
const GUID = JSON.parse(fs.readFileSync(path.join(CORE, 'guid.json'), 'utf8'));
const byId = Object.fromEntries(CARDS.cards.map((c) => [c.id, c]));
const nameToId = Object.fromEntries(CARDS.cards.map((c) => [norm(c.n), c.id]));
const TOX = globalThis.SpamDuel.toxPool(CARDS.cards);

// ---------- réglages et données gardées entre deux lancements ----------
const STORE = () => path.join(app.getPath('userData'), 'overlay-data.json');
let store = { settings: {}, lastDeck: null, decks: {}, games: [], learned: {} };
function loadStore() { try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE(), 'utf8')) }; } catch (e) { /* premier lancement */ } }
let saveT = null;
function saveStore() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(STORE(), JSON.stringify(store)); } catch (e) { /* disque plein ou verrouillé */ } }, 500); }

function gameDir() {
  if (process.env.SPAM_GAME_DIR) return process.env.SPAM_GAME_DIR;
  if (store.settings.gameDir && fs.existsSync(store.settings.gameDir)) return store.settings.gameDir;
  const d = path.join(os.homedir(), 'AppData', 'LocalLow', 'Ticroco', 'Spam');
  return d;
}
const logPath = () => path.join(gameDir(), 'Player.log');
const replayDir = () => path.join(gameDir(), 'replays');

// ---------- fenêtre ----------
let win = null, tray = null, editMode = false, visible = true;
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = store.settings.bounds || { width: 340, height: 700, x: wa.x + wa.width - 360, y: wa.y + 80 };
  win = new BrowserWindow({
    ...b, frame: false, transparent: true, resizable: true, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // l'overlay n'apparaît pas dans ses propres captures d'écran
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  setEdit(false);
  const remember = () => { if (win && !win.isDestroyed()) { store.settings.bounds = win.getBounds(); saveStore(); } };
  win.on('moved', remember); win.on('resized', remember);
}
// mode normal : les clics traversent l'overlay et vont au jeu ; mode édition : on peut le déplacer et cliquer dedans
function setEdit(on) {
  editMode = on;
  if (!win) return;
  win.setIgnoreMouseEvents(!on, { forward: true });
  win.setFocusable(on);
  if (on) win.focus();
  send('mode', { edit: on });
  buildTray();
}
function toggleVisible() { visible = !visible; if (visible) win.showInactive(); else win.hide(); buildTray(); }
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png'));
  if (!tray) { tray = new Tray(icon); tray.setToolTip('Overlay SPAM'); tray.on('click', toggleVisible); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Masquer (Ctrl+Maj+S)' : 'Afficher (Ctrl+Maj+S)', click: toggleVisible },
    { label: editMode ? 'Verrouiller (Ctrl+Maj+D)' : 'Déplacer / cliquer (Ctrl+Maj+D)', click: () => setEdit(!editMode) },
    { type: 'separator' },
    { label: store.settings.noVision ? 'Lecture de l’écran : désactivée' : 'Lecture de l’écran : activée', type: 'checkbox', checked: !store.settings.noVision, click: () => { store.settings.noVision = !store.settings.noVision; saveStore(); buildTray(); } },
    { label: 'Choisir le dossier du jeu…', click: chooseDir },
    { label: 'Ouvrir le dossier des replays', click: () => shell.openPath(replayDir()) },
    { label: 'Ouvrir l’Atelier SPAM', click: () => shell.openExternal('https://ylfik.github.io/spam-deckbuilder/') },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
}
async function chooseDir() {
  const r = await dialog.showOpenDialog({ title: 'Dossier de SPAM (celui qui contient Player.log)', defaultPath: gameDir(), properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  store.settings.gameDir = r.filePaths[0]; saveStore();
  logPos = 0; state = newState(); scanReplays(true); tick();
}

// ---------- lecture du Player.log ----------
const lookup = { guid: GUID, name: nameToId };
const newState = () => { const s = new MatchState(lookup); s.decks = store.decks || {}; s.lastDeck = store.lastDeck; return s; };
let state = null, logPos = 0, logSize = -1, partial = '';
function tick() {
  let st; try { st = fs.statSync(logPath()); } catch (e) { send('status', { log: false, path: logPath() }); return; }
  // le jeu recrée Player.log à chaque lancement : on repart du début
  if (st.size < logPos) { logPos = 0; partial = ''; state = newState(); }
  if (st.size === logPos) return;
  const fd = fs.openSync(logPath(), 'r');
  const len = Math.min(st.size - logPos, 8 * 1024 * 1024);
  const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, logPos); fs.closeSync(fd);
  logPos += len;
  const text = partial + buf.toString('utf8'); const lines = text.split(/\r?\n/); partial = lines.pop();
  let changed = false;
  for (const l of lines) {
    const ev = parseLine(l); if (!ev) continue;
    if (state.apply(ev)) changed = true;
    if (ev.k === 'decks') { store.decks = state.decks; store.lastDeck = state.lastDeck; saveStore(); }
    if (ev.k === 'saved' || ev.k === 'result') setTimeout(() => scanReplays(false), 1500);
  }
  send('status', { log: true, path: logPath() });
  if (changed) publish();
}

// ---------- analyse dans un thread ----------
let worker = null, lastKey = '', pending = null, pendingShop = null, busy = false, lastAnalysis = null, lastSpec = null, shopKey = '';
let talentDeck = null; // deck enregistré qui correspond aux cartes vues à l'écran (pour leurs talents)
function talentOf(id) {
  const d = talentDeck || (state && state.lastDeck); if (!d) return 0;
  const c = d.cards.find((x) => GUID[x.id] === id); return c ? c.talent || 0 : 0;
}
function publish() {
  const snap = state.snapshot();
  // ce que l'écran montre passe avant le journal : mes 4 cartes, celles de l'adversaire, leurs PV, le tour
  if (vis.live) {
    const vm = vis.me.map((x) => x.id).filter(Boolean), vo = vis.opp.map((x) => x.id).filter(Boolean);
    if (vm.length >= 3) talentDeck = Object.values(state.decks || {}).find((d) => { const ids = d.cards.map((c) => GUID[c.id]); return vm.every((id) => ids.includes(id)); }) || null;
    if (vm.length >= 3) { snap.mine = [...vm, ...snap.mine.filter((id) => !vm.includes(id))].slice(0, 4); snap.minePinned = vm; }
    if (vo.length) snap.opp = [...vo, ...snap.opp.filter((id) => !vo.includes(id))].slice(0, 4);
    snap.hpFrac = {}; [...vis.me, ...vis.opp].forEach((x) => { if (x.id && x.hp != null) snap.hpFrac[x.id] = x.hp; });
    if (vis.turn) snap.turn = vis.turn;
    snap.vision = true;
  }
  const mine = snap.mine.map((id) => ({ id, t: talentOf(id) }));
  const opp = snap.opp.map((id) => ({ id, t: 0 }));
  const key = JSON.stringify([mine, opp]);
  send('match', { ...snap, cards: [...snap.mine, ...snap.opp].reduce((o, id) => { const c = byId[id]; if (c) o[id] = { n: c.n, el: c.el, hp: c.hp, r: c.r }; return o; }, {}) });
  lastSpec = { mine, opp };
  if (key !== lastKey && mine.length) { lastKey = key; pending = { key, mine, opp, n: opp.length === 4 ? 160 : 0 }; runNext(); }
  else if (lastAnalysis) send('analysis', lastAnalysis);
}
function runNext() {
  if (busy || (!pending && !pendingShop)) return;
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'src', 'analysis.js'));
    worker.on('message', (m) => {
      busy = false;
      if (m.type === 'shop') { if (m.key === shopKey && m.result) send('shop-advice', m.result); }
      else if (m.result && m.key === lastKey) { lastAnalysis = m.result; send('analysis', m.result); }
      if (m.error) send('error', m.error); runNext();
    });
    worker.on('error', (e) => { busy = false; worker = null; send('error', String(e)); });
  }
  busy = true;
  if (pendingShop) { worker.postMessage(pendingShop); pendingShop = null; return; } // le conseil de boutique passe en premier
  send('analysing', true); worker.postMessage(pending); pending = null;
}

// ---------- replays : statistiques de boutique et de critiques ----------
const known = () => new Set(store.games.map((g) => g.uid));
let scanning = false;
async function scanReplays(force) {
  if (scanning) return; scanning = true;
  try {
    const have = known(); let added = 0; let last = null;
    for (const f of stats.listReplays(replayDir())) {
      const uid = path.basename(f, '.srpl');
      if (!force && have.has(uid)) continue;
      try { const g = await stats.readOne(f, GUID); if (!have.has(g.uid)) { store.games.push(g); have.add(g.uid); added++; if (!force && Date.now() - Date.parse(g.start || 0) < 3 * 3600e3) learnFromReplay(g); } if (!last || g.start > last.start) last = g; } catch (e) { /* replay illisible : ignoré */ }
    }
    if (added) {
      store.games.sort((a, b) => (a.start < b.start ? -1 : 1));
      // mon dernier deck joué (le plus fiable pour reconnaître mes cartes à la partie suivante)
      const lg = store.games[store.games.length - 1];
      if (lg && lg.my && lg.my.length === 4) {
        const ids = lg.my.map((id) => Object.keys(GUID).find((g) => GUID[g] === id));
        const prev = store.lastDeck && store.lastDeck.cards || [];
        store.lastDeck = { id: 'replay', name: 'Dernière partie', cards: ids.map((g) => ({ id: g, talent: (prev.find((c) => c.id === g) || {}).talent || 0 })) };
        if (state) state.lastDeck = store.lastDeck;
      }
      saveStore();
    }
    send('stats', { ...stats.summary(store.games), last: store.games.slice(-8).reverse() });
  } finally { scanning = false; }
}

// ---------- lecture de l'écran ----------
const vis = { live: false, scene: 'other', me: [], opp: [], turn: null, misses: 0 };
const slotMem = { me: [{}, {}, {}, {}], opp: [{}, {}, {}, {}] }; // mémoire par emplacement (tolère un survol qui cache une carte)
let refs = null, shopRef = null, visBusy = false, lastTurnRead = 0, lastShopRead = 0, shopOpenSince = 0, ocrReady = null;
let baseRefs = null;
const nrm = (a) => { const f = Float32Array.from(a); let q = 0; for (const v of f) q += v * v; q = Math.sqrt(q) || 1; return f.map((v) => v / q); };
function loadRefs() {
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'vision', 'refs.json'), 'utf8'));
  const drop = (process.env.SPAM_DROP_REFS || '').split(',').filter(Boolean); // test : simule des illustrations inconnues
  baseRefs = Object.entries(R.refs).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, nrm(v)]); shopRef = nrm(R.shopRef);
  rebuildRefs();
}
// illustrations apprises en jeu (full art, alternatives) : ajoutées aux références, gardées d'une session à l'autre
function rebuildRefs() { refs = [...baseRefs, ...Object.entries(store.learned || {}).flatMap(([id, arr]) => arr.map((v) => [id, nrm(v)]))]; }
function learn(id, feat) {
  if (!id || !feat || !byId[id]) return;
  const best = refs.filter(([k]) => k === id).reduce((b, [, v]) => Math.max(b, V.dot(v, feat)), -1);
  if (best >= 0.95) return; // déjà reconnue telle quelle
  const L = (store.learned = store.learned || {}); L[id] = [...(L[id] || []), Array.from(feat, (v) => Math.round(v * 1000))].slice(-4);
  rebuildRefs(); saveStore(); send('learned', { id, n: byId[id].n });
}
const NAMES = CARDS.cards.map((c) => [c.id, c.n]);
const slotFeat = { me: [null, null, null, null], opp: [null, null, null, null] }; // dernière empreinte des emplacements non reconnus
const lastNameRead = {};
async function grab() {
  if (process.env.SPAM_FAKE_SCREEN) { // test : une capture d'écran tient lieu d'écran (plusieurs fichiers séparés par des virgules, en boucle)
    const { PNG } = require('pngjs'); const list = process.env.SPAM_FAKE_SCREEN.split(','); grab.k = ((grab.k || 0) + 1);
    const f = list[Math.min(list.length - 1, Math.floor(grab.k / 6))]; const p = PNG.sync.read(fs.readFileSync(f)); return { w: p.width, h: p.height, data: p.data, bgra: false };
  }
  const disp = screen.getPrimaryDisplay(); const { width, height } = disp.size; const sf = disp.scaleFactor || 1;
  const W = Math.round(width * sf), H = Math.round(height * sf);
  const k = Math.min(1, 1920 / W); // au plus 1920 de large : suffisant et plus rapide
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(W * k), height: Math.round(H * k) } });
  const src = srcs.find((x) => String(x.display_id) === String(disp.id)) || srcs[0]; if (!src) return null;
  const sz = src.thumbnail.getSize(); if (!sz.width) return null;
  return { w: sz.width, h: sz.height, data: src.thumbnail.toBitmap(), bgra: true };
}
let visMatch = null;
function stable(row, k, m) {
  if (state && state.id !== visMatch) { visMatch = state.id; for (const r of ['me', 'opp']) { slotMem[r] = [{}, {}, {}, {}]; slotFeat[r] = [null, null, null, null]; } }
  const mem = slotMem[row][k];
  if (m.id) { if (mem.cand === m.id) mem.n = (mem.n || 0) + 1; else { mem.cand = m.id; mem.n = 1; } if (mem.n >= 2 || mem.id === m.id) { mem.id = m.id; mem.miss = 0; } if (m.hp != null && mem.id === m.id) mem.hp = m.hp; }
  else if (mem.id && ++mem.miss > 6) { mem.id = null; mem.hp = null; } // emplacement vide depuis plusieurs secondes : carte morte
  return { id: mem.id || null, hp: mem.id ? (mem.hp ?? null) : null };
}
// carte présente mais pas reconnue par son illustration : on lit son nom ; si ça marche, on apprend l'illustration
async function identifyUnknown(img, a) {
  for (const row of ['me', 'opp']) for (let k = 0; k < 4; k++) {
    const x = V.CFG.XS[k]; const present = V.hpFraction(img, x, row) > 0;
    if (!present || vis[row][k].id) { slotFeat[row][k] = null; continue; }
    slotFeat[row][k] = V.slotFeature(img, x, row === 'me' ? V.CFG.Y_ME : V.CFG.Y_OPP);
    const key = row + k; if (Date.now() - (lastNameRead[key] || 0) < 4000) continue; lastNameRead[key] = Date.now();
    ocrReady = ocrReady || OCR.init(path.join(app.getPath('userData'), 'ocr')); await ocrReady;
    const taken = new Set(vis[row].map((s) => s.id).filter(Boolean));
    let r = await OCR.readCardName(img, V.nameBox(row, x), NAMES.filter(([id]) => !taken.has(id)));
    if (!r && row === 'me') r = await OCR.readAbilities(img, x, V.CFG.Y_ME - 1, CARDS.cards.filter((c) => !taken.has(c.id)));
    if (r) { const mem = slotMem[row][k]; mem.id = r.id; mem.cand = r.id; mem.n = 2; mem.miss = 0; mem.hp = V.hpFraction(img, x, row); vis[row][k] = { id: r.id, hp: mem.hp }; learn(r.id, slotFeat[row][k]); slotFeat[row][k] = null; }
  }
  // dernier recours : une seule carte inconnue sur une rangée et une seule carte connue par le journal qui manque à l'écran
  for (const row of ['me', 'opp']) {
    const unk = [0, 1, 2, 3].filter((k) => slotFeat[row][k]); if (unk.length !== 1) continue;
    const snap = state.snapshot(); const fromLog = (row === 'me' ? snap.minePinned : snap.opp) || [];
    const missing = fromLog.filter((id) => !vis[row].some((s) => s.id === id)); if (missing.length !== 1) continue;
    const k = unk[0], mem = slotMem[row][k]; mem.id = missing[0]; mem.cand = missing[0]; mem.n = 2; mem.miss = 0;
    vis[row][k] = { id: missing[0], hp: V.hpFraction(img, V.CFG.XS[k], row) }; learn(missing[0], slotFeat[row][k]); slotFeat[row][k] = null;
  }
}
// fin de partie : le replay donne les 8 cartes ; une illustration restée inconnue est apprise par élimination
function learnFromReplay(g) {
  for (const [row, list] of [['me', g.my || []], ['opp', g.opp || []]]) {
    const unk = [0, 1, 2, 3].filter((k) => slotFeat[row][k]); if (unk.length !== 1) continue;
    const missing = list.filter((id) => byId[id] && !vis[row].some((s) => s.id === id));
    if (missing.length === 1) learn(missing[0], slotFeat[row][unk[0]]);
  }
}

async function visionTick() {
  if (process.env.SPAM_DEBUG) console.log('tick', visBusy, !!store.settings.noVision, !!refs);
  if (visBusy || store.settings.noVision || !refs) return; visBusy = true;
  try {
    const img = await grab(); if (!img) return;
    const a = V.analyseFrame(img, refs, shopRef); const now = Date.now();
    if (a.scene === 'board') {
      vis.misses = 0; vis.scene = 'board'; vis.live = true;
      vis.me = a.me.map((m, k) => stable('me', k, m)); vis.opp = a.opp.map((m, k) => stable('opp', k, m));
      await identifyUnknown(img, a);
      if (shopOpenSince) { shopOpenSince = 0; send('shop', null); }
      if (now - lastTurnRead > 3000) { lastTurnRead = now; ocrReady = ocrReady || OCR.init(path.join(app.getPath('userData'), 'ocr')); await ocrReady; const b = await OCR.readBoard(img); if (b.turn) vis.turn = b.turn; }
      publish();
    } else if (a.scene === 'shop') {
      vis.scene = 'shop';
      if (!shopOpenSince) shopOpenSince = now;
      if (now - lastShopRead > 2500) {
        lastShopRead = now; ocrReady = ocrReady || OCR.init(path.join(app.getPath('userData'), 'ocr')); await ocrReady;
        const sh = await OCR.readShop(img, TOX); if (sh.turn) vis.turn = sh.turn;
        send('shop', { ...sh, names: Object.fromEntries(CARDS.cards.map((c) => [c.id, c.n])) });
        const offers = sh.offers.map((o) => (o.tox ? o.tox.id : null)); const key = JSON.stringify([offers, lastSpec && lastSpec.mine]);
        if (lastSpec && lastSpec.mine.length && key !== shopKey) {
          shopKey = key; const alive = lastSpec.mine.map((x) => { const v = vis.me.find((m) => m.id === x.id); return !v || v.hp == null || v.hp > 0; });
          pendingShop = { type: 'shop', key, mine: lastSpec.mine, opp: lastSpec.opp, offers, alive, n: 150 }; send('shop-busy', true); runNext();
        }
      }
    } else if (++vis.misses > 8 && vis.live) { vis.live = false; vis.scene = 'other'; if (shopOpenSince) { shopOpenSince = 0; send('shop', null); } publish(); }
    if (process.env.SPAM_DEBUG) console.log('vision', vis.scene, vis.me.map((x) => x.id).join(','), vis.opp.map((x) => x.id + ':' + x.hp).join(','), vis.turn);
    send('vision', { scene: vis.scene, live: vis.live });
  } catch (e) { send('vision', { error: String(e && e.message || e) }); }
  finally { visBusy = false; }
}

ipcMain.on('ui-ready', () => { publish(); scanReplays(false); send('mode', { edit: editMode }); });
ipcMain.on('height', (_, h) => { // la fenêtre suit la hauteur du contenu
  if (!win || win.isDestroyed()) return; const b = win.getBounds(); const nh = Math.max(120, Math.min(1400, Math.ceil(h) + 14));
  if (Math.abs(b.height - nh) > 2) win.setBounds({ ...b, height: nh });
});
ipcMain.on('toggle-edit', () => setEdit(!editMode));
ipcMain.on('hide', () => toggleVisible());
ipcMain.on('open-site', () => shell.openExternal('https://ylfik.github.io/spam-deckbuilder/'));
ipcMain.on('choose-dir', () => chooseDir());
ipcMain.on('set-opp', (_, ids) => { // correction à la main : cartes adverses choisies dans la liste
  state.opp = new Map(ids.filter((id) => byId[id]).map((id) => [id, { id, why: 'manuel' }])); publish();
});
ipcMain.handle('all-cards', () => CARDS.cards.map((c) => ({ id: c.id, n: c.n, el: c.el })));

app.whenReady().then(() => {
  loadStore();
  state = newState();
  createWindow(); buildTray();
  globalShortcut.register('CommandOrControl+Shift+S', toggleVisible);
  globalShortcut.register('CommandOrControl+Shift+D', () => setEdit(!editMode));
  tick(); setInterval(tick, 400);
  try { loadRefs(); } catch (e) { console.error('empreintes introuvables', e); }
  setInterval(visionTick, 900);
  setInterval(() => scanReplays(false), 20000);
  // test : capture d'écran de l'overlay (SPAM_SHOT=fichier.png SPAM_SHOT_AT=ms)
  if (process.env.SPAM_SHOT) setTimeout(async () => { const im = await win.webContents.capturePage(); fs.writeFileSync(process.env.SPAM_SHOT, im.toPNG()); app.quit(); }, +(process.env.SPAM_SHOT_AT || 6000));
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); OCR.close().catch(() => {}); });
app.on('window-all-closed', () => app.quit());
if (!app.requestSingleInstanceLock()) app.quit();
