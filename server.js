'use strict';
/*
 * terraria-status, live status page for the tModLoader dedicated server.
 *
 * Zero external deps. Polls Docker on timers and serves a cached JSON snapshot
 * at /api/status plus the static page. Runs on the HOST (under PM2) so it can
 * call `docker` without mounting docker.sock into an internet-facing container.
 *
 * SECURITY: the server console log contains the world password. This process
 * only ever extracts the `playing` command's player list from the logs and
 * strips IPs, it must NEVER surface raw log lines or the password to clients.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { isCompleteWorld } = require('./world-snapshot');
const { parsePlaying, NAME_MAX } = require('./console-players');
const { sanitizeModBosses, pickLive } = require('./world-extras');
const { parseEvents, recentKills } = require('./fight-events');
const { createFeed } = require('./discord-feed');

// ---- deploy config (override via environment; defaults match test server) --
const PORT = parseInt(process.env.STATUS_PORT || '3063', 10);
const HOST = process.env.STATUS_BIND || '127.0.0.1'; // keep localhost; expose via reverse proxy
// Public origin, used by robots.txt / sitemap.xml (SEO). Override when self-hosting.
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://terraria.ronlab.site').replace(/\/+$/, '');
const CONTAINER = process.env.TMOD_CONTAINER || 'tmodloader';
const DATA_DIR = process.env.TMOD_DATA_DIR || (process.platform === 'win32' ? 'C:\\docker\\tModLoader\\data\\tModLoader' : '/opt/terraria-tmodloader/data/tModLoader');
const WORLD_NAME = process.env.TMOD_WORLD || 'TestWorld';
const WORLD_FILE = path.join(DATA_DIR, 'Worlds', WORLD_NAME + '.wld');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Optional: written by the companion server-side mod (see optional-serverside-mod/).
// If present & fresh, per-player character stats appear in the site's player modal.
const STATS_FILE = process.env.TMOD_STATS_FILE || path.join(DATA_DIR, 'playerstats.json');
// The world password (TMOD_PASS=... in docker-compose.yml or .env) gates the day/night
// button: players already have it to join. Read server-side only, never sent out.
const PASS_FILE = process.env.TMOD_PASS_FILE || (
  process.platform === 'win32'
    ? path.join(DATA_DIR, '..', '..', 'docker-compose.yml')
    : path.join(DATA_DIR, '..', '..', '.env')
);
// The mod rewrites the file every ~3 s while anyone is online. Newer than this, it
// is the live truth about who is connected.
const STATS_FRESH_MS = 15000;
// Boss fights, invasions and deaths, one JSON line each, written by the same mod
// (BossFights.cs). Feeds the Discord webhook and /api/fights.
const EVENTS_FILE = process.env.TMOD_EVENTS_FILE || path.join(DATA_DIR, 'serverevents.jsonl');
const ENABLED_MODS_FILE = path.join(DATA_DIR, 'Mods', 'enabled.json');

// ---- mod metadata catalogue ----------------------------------------------
const KNOWN_MODS = {
  'RecipeBrowser': { id: '2619954303', name: 'Recipe Browser', rarity: 'blue', desc: 'Browse recipes and see where items are used.' },
  'MagicStorage': { id: '2563309347', name: 'Magic Storage', rarity: 'purple', desc: 'Centralized network storage: deposit, search, and craft directly.' },
  'BossChecklist': { id: '2669644269', name: 'Boss Checklist', rarity: 'orange', desc: 'Progression checklist: bosses, order, drops, and summons.' },
  'Census': { id: '2687866031', name: 'Census', rarity: 'green', desc: 'Town NPC checklist: requirements for each resident to spawn.' },
  'AlchemistNPCLite': { id: '2599842771', name: 'AlchemistNPC Lite', rarity: 'lime', desc: 'NPCs selling potions, buffs, and teleports for quality of life.' },
  'OreExcavator': { id: '2565639705', name: 'Ore Excavator', rarity: 'yellow', desc: 'Vein mining: mine an entire ore vein or tree in a single swing.' },
  'SerousCommonLib': { id: '2908170107', name: 'SerousCommonLib', rarity: 'gray', desc: 'Support library required by Magic Storage.' },
  'SteamAchievementFix': { id: '3021379176', name: 'Steam Achievement Fix', rarity: 'cyan', desc: 'Unlocks achievements on your Steam profile in multiplayer.' },
  'Fargowiltas': { id: '2570931073', name: "Fargo's Mutant Mod", rarity: 'red', desc: 'Instant construction and the Mutant NPC who sells boss summons.' },
  'FargowiltasSouls': { id: '2815540735', name: "Fargo's Souls Mod", rarity: 'purple', desc: 'New enchantments, souls, and optional Eternity Mode.' },
  'Luminance': { id: '3222493606', name: 'Luminance', rarity: 'gray', desc: 'Support graphics library required by Fargo\'s Souls.' },
  'NoPylonRestrictions': { id: '2812377597', name: 'No Pylon Restrictions', rarity: 'cyan', desc: 'Allows multiple pylons of each biome across larger worlds.' },
  'InfernoAura': { id: '3834360329', name: 'Inferno Aura', rarity: 'orange', desc: 'Replaces the giant Inferno Potion ring with a stylish flame aura.' },
  'StatusExport': { id: null, name: 'StatusExport', rarity: 'orange', desc: 'Server companion mod exporting live character, inventory, and world stats.' },
};

function getActiveMods() {
  try {
    if (fs.existsSync(ENABLED_MODS_FILE)) {
      const list = JSON.parse(fs.readFileSync(ENABLED_MODS_FILE, 'utf8'));
      if (Array.isArray(list) && list.length > 0) {
        return list.map((modName) => {
          if (KNOWN_MODS[modName]) return KNOWN_MODS[modName];
          return { id: null, name: modName, rarity: 'blue', desc: 'Active server mod.' };
        });
      }
    }
  } catch (_) {}
  return [];
}

const WORLD = {
  name: WORLD_NAME,
  size: process.env.TMOD_WORLD_SIZE || 'Medium',
  difficulty: process.env.TMOD_DIFFICULTY || 'Expert',
  maxPlayers: parseInt(process.env.TMOD_MAXPLAYERS || '8', 10),
};

const SERVER = {
  host: process.env.SERVER_HOST || 'play.ronlab.site',
  ip: process.env.SERVER_IP || 'play.ronlab.site',
  port: parseInt(process.env.SERVER_PORT || '7777', 10),
  passwordProtected: true,
  steamAppId: 1281930,         // tModLoader on Steam (steam://run/<id> opens it)
  tmodloaderVersion: null,     // running version, filled live by collectVersion()
  latestVersion: null,         // latest stable on GitHub, filled by collectLatestVersion()
  upToDate: null,              // true/false/null, running >= latest?
  terrariaVersion: '1.4.4.9',
  // Whether a decoded pixel-sprite set is present (else the page draws category
  // glyphs). Populated once at startup from the public/sprites/ dirs.
  sprites: { item: false, buff: false, npc: false },
};

// A sprite set is "present" only if the dir exists AND holds at least one file -
// an empty dir must not switch the page into 404-per-item mode.
function hasSprites(sub) {
  try {
    const dir = path.join(PUBLIC_DIR, 'sprites', sub);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(png|webp|jpe?g)$/i.test(f));
  } catch (_) { return false; }
}

// ---- live snapshot (served to clients) ------------------------------------
let snapshot = {
  updatedAt: null,
  online: false,
  container: { status: 'unknown', startedAt: null, uptimeSec: null, restarts: null },
  resources: {
    cpuPerc: null,
    memUsedBytes: null, memLimitBytes: null, memPerc: null,
    memUsedText: null, memLimitText: null,
    netRxText: null, netTxText: null,
    diskWorldBytes: null,
  },
  // list: [{ name, onlineForSec, stats|null }]. statsSource=true when the optional
  // companion mod is feeding playerstats.json (life/gear/inventory); false → names only.
  players: { count: 0, max: WORLD.maxPlayers, list: [], statsSource: false, sampledAt: null },
  world: Object.assign({ lastSaveAt: null, live: null, progress: null, tiles: null }, WORLD),
  server: SERVER,
  mods: getActiveMods(),
};

// Last complete copy of the world, for the /map/ viewer (the browser parses it).
let worldSnapshot = null; // { buf, etag, mtime }

// name -> firstSeen epoch ms, so we can show "online for ~X" without a mod.
const sessions = Object.create(null);

// ---- helpers ---------------------------------------------------------------
function run(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, out: (stdout || '').toString() });
    });
  });
}

// "1.27GiB", "4GiB", "512MiB", "1.5GB", "32.4MB" -> bytes
function toBytes(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }[unit];
  return mult ? Math.round(n * mult) : null;
}

// ---- collectors ------------------------------------------------------------
async function collectInspect() {
  const { err, out } = await run('docker', ['inspect', CONTAINER]);
  if (err) { snapshot.online = false; snapshot.container.status = 'down'; return; }
  try {
    const info = JSON.parse(out)[0];
    const running = !!(info.State && info.State.Running);
    snapshot.online = running;
    snapshot.container.status = info.State ? info.State.Status : 'unknown';
    snapshot.container.restarts = info.RestartCount;
    const started = info.State && info.State.StartedAt;
    if (started && started !== '0001-01-01T00:00:00Z') {
      snapshot.container.startedAt = started;
      snapshot.container.uptimeSec = Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 1000));
    }
  } catch (_) { /* keep last */ }
}

async function collectStats() {
  const { err, out } = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', CONTAINER]);
  if (err || !out.trim()) return;
  try {
    const s = JSON.parse(out.trim().split('\n')[0]);
    const r = snapshot.resources;
    r.cpuPerc = parseFloat(s.CPUPerc);
    r.memPerc = parseFloat(s.MemPerc);
    const [used, limit] = (s.MemUsage || '').split('/').map((x) => x.trim());
    r.memUsedText = used || null;
    r.memLimitText = limit || null;
    r.memUsedBytes = toBytes(used);
    r.memLimitBytes = toBytes(limit);
    const [rx, tx] = (s.NetIO || '').split('/').map((x) => x.trim());
    r.netRxText = rx || null;
    r.netTxText = tx || null;
  } catch (_) { /* keep last */ }
}

// Optional per-player character stats, written by the companion server-side mod.
// Ignored if missing or stale (>60 s old) so a crashed/removed mod can't show
// ghost data. Never throws.
function readModStats() {
  try {
    const st = fs.statSync(STATS_FILE);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > 60000) return null;                     // stale mod output
    if (st.size > 2 * 1024 * 1024) return null;         // bound parse cost (full inventories × 8 players)
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const byName = Object.create(null);
    const arr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
    for (const p of arr) if (p && typeof p.name === 'string') byName[p.name] = p;
    // Newer mod builds also emit a live world summary (day/night, progression,
    // downed bosses); older ones don't, tolerate both.
    const world = (data && typeof data.world === 'object') ? data.world : null;
    return { byName, world, fresh: ageMs <= STATS_FRESH_MS };
  } catch (_) { return null; }
}

// The world's progress outlives the player stats: with nobody online the mod stops
// writing, but its last export is still true until someone plays again. So this one
// ignores the file's age. Only booleans leave here, whatever the file holds.
function readWorldProgress() {
  try {
    const st = fs.statSync(STATS_FILE);
    if (st.size > 2 * 1024 * 1024) return;
    const world = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).world;
    if (!world || typeof world.downed !== 'object' || !world.downed) return;
    const downed = {};
    for (const [key, value] of Object.entries(world.downed)) downed[key] = value === true;
    snapshot.world.progress = {
      crimson: world.crimson === true,
      downed,
      modBosses: sanitizeModBosses(world.modBosses, modBossIcons),
    };
    if (Number.isInteger(world.width) && Number.isInteger(world.height)
        && world.width > 0 && world.width <= 8401 && world.height > 0 && world.height <= 2401) {
      snapshot.world.tiles = { width: world.width, height: world.height };
    }
  } catch (_) { /* keep last */ }
}

// Icon files written by tools/build-modboss-icons.py. The export names a texture path;
// only a key that maps to one of these files ever reaches the page.
const MODBOSS_DIR = path.join(PUBLIC_DIR, 'sprites', 'modboss');
let modBossIcons = new Set();
function loadModBossIcons() {
  try { modBossIcons = new Set(fs.readdirSync(MODBOSS_DIR).filter((f) => /^[A-Za-z0-9_]+\.png$/.test(f)).map((f) => f.slice(0, -4))); }
  catch (_) { modBossIcons = new Set(); }
}

async function collectPlayers() {
  readWorldProgress();
  // Only meaningful while the container is up.
  if (!snapshot.online) {
    snapshot.players.count = 0; snapshot.players.list = []; snapshot.players.statsSource = false;
    snapshot.world.live = null;
    for (const n of Object.keys(sessions)) delete sessions[n];
    return;
  }
  await run('docker', ['exec', CONTAINER, 'inject', 'playing']);
  await new Promise((r) => setTimeout(r, 900));
  // Read the console straight from the tmux pane, fast and clean, unlike
  // `docker logs --tail` which gets slow once the json log grows large.
  const { err, out } = await run('docker', ['exec', CONTAINER, 'tmux', 'capture-pane', '-p', '-S', '-60']);
  if (err) return;
  // Player chat reaches this console and can hold line breaks, so a connected player
  // can print a fake `playing` reply. The mod reads Main.player directly: trust it
  // while it is live. The console only speaks for an empty server (the mod is idle
  // then, and a forgery needs a connected player) or a missing mod.
  const mod = readModStats();
  const names = mod && mod.fresh
    ? Object.keys(mod.byName).map((n) => n.slice(0, NAME_MAX)).slice(0, WORLD.maxPlayers)
    : parsePlaying(out);
  if (!names) return;                            // no complete reply on screen: keep the last list
  // Track session start (approx: first poll that sees the name) and drop leavers.
  const now = Date.now();
  for (const n of names) if (!sessions[n]) sessions[n] = now;
  for (const n of Object.keys(sessions)) if (!names.includes(n)) delete sessions[n];

  snapshot.players.statsSource = !!mod;
  snapshot.world.live = mod ? pickLive(mod.world) : null;   // live day/night, progression, events, tick rate (or null)
  snapshot.players.list = names.map((n) => ({
    name: n,
    onlineForSec: Math.floor((now - sessions[n]) / 1000),
    stats: (mod && mod.byName[n]) || null,
  }));
  snapshot.players.count = names.length;
  snapshot.players.sampledAt = new Date().toISOString();
}

async function collectVersion() {
  // The running version is printed to Launch.log at boot ("tModLoader v2026.5.3.0").
  const { err, out } = await run('docker', ['exec', CONTAINER, 'sh', '-c',
    "grep -hoE 'tModLoader v[0-9.]+' /terraria-server/tModLoader-Logs/Launch.log 2>/dev/null | tail -1"]);
  if (!err) {
    const m = out.match(/tModLoader v([\d.]+)/);
    if (m) { snapshot.server.tmodloaderVersion = m[1]; return; }
  }
  // Fallback: the version label our Dockerfile stamps on the image.
  const lbl = await run('docker', ['inspect', '--format', '{{index .Config.Labels "tmod.version"}}', CONTAINER]);
  if (!lbl.err) {
    const v = lbl.out.trim().replace(/^v/, '');
    if (v) snapshot.server.tmodloaderVersion = v;
  }
}

// Compare dotted numeric versions ("2026.5.3.0" vs "2026.05.3.0"). Sign of a-b.
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function collectLatestVersion() {
  // GitHub latest stable tag (unauthenticated: 60 req/h, this runs every 5 min).
  try {
    const resp = await fetch('https://api.github.com/repos/tModLoader/tModLoader/releases/latest', {
      headers: { 'user-agent': 'terraria-status', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return;
    const j = await resp.json();
    const tag = String(j.tag_name || '').replace(/^v/, '');
    if (!/^\d/.test(tag)) return;
    snapshot.server.latestVersion = tag;
    const cur = snapshot.server.tmodloaderVersion;
    snapshot.server.upToDate = cur ? cmpVer(cur, tag) >= 0 : null;
  } catch (_) { /* keep last */ }
}

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await getDirSize(fullPath);
        if (sub !== null) total += sub;
      } else if (entry.isFile()) {
        const st = await fs.promises.stat(fullPath);
        total += st.size;
      }
    }
    return total;
  } catch (_) {
    return null;
  }
}

async function collectDisk() {
  const worldsDir = path.join(DATA_DIR, 'Worlds');
  const { err, out } = await run('du', ['-sb', worldsDir]);
  if (!err) {
    const n = parseInt(out.split(/\s+/)[0], 10);
    if (!isNaN(n)) snapshot.resources.diskWorldBytes = n;
  } else {
    const n = await getDirSize(worldsDir);
    if (n !== null) snapshot.resources.diskWorldBytes = n;
  }
  snapshot.mods = getActiveMods();
  fs.stat(WORLD_FILE, (e, st) => { if (!e) snapshot.world.lastSaveAt = st.mtime.toISOString(); });
}

async function collectWorldSnapshot() {
  const st = await fs.promises.stat(WORLD_FILE);
  if (worldSnapshot && worldSnapshot.mtime.getTime() === st.mtime.getTime()) return;
  const buf = await fs.promises.readFile(WORLD_FILE);
  if (!isCompleteWorld(buf, WORLD_NAME)) return;   // mid-save: keep the last good copy
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
  worldSnapshot = { buf, etag, mtime: st.mtime };
}

// Discord webhook (no-op until DISCORD_WEBHOOK_URL / discord-webhook.url exists).
const feed = createFeed({ dir: __dirname, eventsFile: EVENTS_FILE });

// Last boss kills for the site, parsed from the tail of the event log. Cached
// briefly: the page polls often and the file only grows.
let fightsCache = { at: 0, body: '[]' };
function fightsJson() {
  if (Date.now() - fightsCache.at < 10000) return fightsCache.body;
  let body = '[]';
  try {
    const st = fs.statSync(EVENTS_FILE);
    const from = Math.max(0, st.size - 512 * 1024);
    const fd = fs.openSync(EVENTS_FILE, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      let text = buf.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);   // drop the cut first line
      body = JSON.stringify(recentKills(parseEvents(text), 20));
    } finally { fs.closeSync(fd); }
  } catch (_) { /* no log yet */ }
  fightsCache = { at: Date.now(), body };
  return body;
}

// ---- poll loops ------------------------------------------------------------
async function fastLoop() {
  try { await collectInspect(); await collectStats(); snapshot.updatedAt = new Date().toISOString(); feed.onSnapshot(snapshot); }
  catch (_) {}
  finally { setTimeout(fastLoop, 8000); }
}
async function playerLoop() {
  try { await collectPlayers(); } catch (_) {}
  finally { setTimeout(playerLoop, 25000); }
}
async function diskLoop() {
  try { await collectDisk(); await collectVersion(); await collectLatestVersion(); } catch (_) {}
  finally { setTimeout(diskLoop, 5 * 60 * 1000); }
}
async function worldLoop() {
  try { await collectWorldSnapshot(); } catch (_) {}
  finally { setTimeout(worldLoop, worldSnapshot ? 60 * 1000 : 5000); }
}

// ---- http ------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function serveWorld(req, res) {
  if (!worldSnapshot) { res.writeHead(503, { 'retry-after': '10' }); return res.end('world not ready'); }
  const { buf, etag, mtime } = worldSnapshot;
  const headers = {
    etag,
    'last-modified': mtime.toUTCString(),
    'cache-control': 'no-cache',
    'x-world-name': WORLD_NAME,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': buf.length });
  res.end(buf);
}

// fs.readFile throws synchronously on some bad paths instead of calling back;
// turn that into an ordinary error so no request can crash the server.
function readFileSafe(file, cb) {
  try { fs.readFile(file, cb); }
  catch (e) { cb(e); }
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('bad request'); } // malformed %-escape must not crash the process
  // A NUL byte (%00) makes fs throw synchronously, which used to kill the process:
  // one request was enough to take the site down.
  if (rel.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Prefix check WITH the separator, bare startsWith(PUBLIC_DIR) would also
  // match a sibling like public-evil/.
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  readFileSafe(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}

// ---- day/night button ------------------------------------------------------
// POST /api/time {"mode":"day"|"night","password":"..."}. The mode only picks one
// of two fixed console commands (dawn / dusk); nothing from the request reaches
// the console. Guards: JSON-only body (a cross-site HTML form can't send it), a
// 1 KB body cap, a timing-safe password check, a lockout per IP after failed
// passwords and a short global cooldown so the sky can't be strobed.
const TIME_COMMANDS = { day: 'dawn', night: 'dusk' };
const TIME_COOLDOWN_MS = 15000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const GLOBAL_FAIL_LIMIT = 30; // across all IPs: caps a brute force spread over many addresses
let globalFails = [];
const failsByIp = new Map(); // ip -> [timestamps]
let lastTimeChange = 0;

function worldPassword() {
  if (process.env.TMOD_PASS) return process.env.TMOD_PASS;
  try {
    const content = fs.readFileSync(PASS_FILE, 'utf8');
    const m = /^\s*(?:-\s*)?TMOD_PASS\s*[:=]\s*(.*)$/m.exec(content);
    const v = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    return v || null;
  } catch (_) { return null; }
}

function sameSecret(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// The site only listens on 127.0.0.1 behind the Cloudflare tunnel, so this header
// can only come from cloudflared.
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').slice(0, 64);
}

function recentFails(ip, now) {
  const list = (failsByIp.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failsByIp.set(ip, list); else failsByIp.delete(ip);
  return list;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads a small JSON body and checks the world password, with the lockout shared by
// every password-gated endpoint. Calls next(data, ip) only for a correct password;
// every other case is answered here.
function withPassword(req, res, maxBody, next) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'json' });
  const ip = clientIp(req);
  let body = '', tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > maxBody) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) return;
    const now = Date.now();
    globalFails = globalFails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (globalFails.length >= GLOBAL_FAIL_LIMIT || recentFails(ip, now).length >= FAIL_LIMIT) return sendJson(res, 429, { error: 'bloqueado', retrySec: Math.ceil(FAIL_WINDOW_MS / 1000) });
    let data;
    try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'json' }); }
    if (!data || typeof data !== 'object') return sendJson(res, 400, { error: 'json' });
    const password = typeof data.password === 'string' ? data.password : '';
    const real = worldPassword();
    if (!real) return sendJson(res, 503, { error: 'desligado' });
    if (!password || !sameSecret(password, real)) {
      const list = recentFails(ip, now); list.push(now); failsByIp.set(ip, list);
      globalFails.push(now);
      return sendJson(res, 403, { error: 'senha', left: Math.max(0, FAIL_LIMIT - list.length) });
    }
    failsByIp.delete(ip);
    Promise.resolve(next(data, ip)).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: 'servidor' }); else res.end(); });
  });
}

function handleTime(req, res) {
  withPassword(req, res, 1024, async (data) => {
    const mode = typeof data.mode === 'string' ? data.mode : '';
    if (!Object.prototype.hasOwnProperty.call(TIME_COMMANDS, mode)) return sendJson(res, 400, { error: 'modo' });
    const now = Date.now();
    const wait = lastTimeChange + TIME_COOLDOWN_MS - now;
    if (wait > 0) return sendJson(res, 429, { error: 'espera', retrySec: Math.ceil(wait / 1000) });
    lastTimeChange = now;
    const { err } = await run('docker', ['exec', CONTAINER, 'inject', TIME_COMMANDS[mode]]);
    if (err) { lastTimeChange = 0; return sendJson(res, 502, { error: 'servidor' }); }
    await run('docker', ['exec', CONTAINER, 'inject', 'say [site] ' + (mode === 'day' ? 'Amanheceu' : 'Anoiteceu') + ' pelo botao do terraria.bobagi.space']);
    sendJson(res, 200, { ok: true, mode });
  });
}

http.createServer((req, res) => {
  if (req.url === '/api/time') return handleTime(req, res);
  if (req.url === '/api/status' || req.url.startsWith('/api/status?')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(snapshot));
  }
  if (req.url === '/api/fights' || req.url.startsWith('/api/fights?')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(fightsJson());
  }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const reqPath = req.url.split('?')[0];
  if (reqPath === '/map/mundo.wld' || reqPath === '/mapa/mundo.wld') return serveWorld(req, res);
  if (req.url === '/map' || req.url === '/mapa') { res.writeHead(301, { location: '/map/' }); return res.end(); }
  if (req.url === '/mapa/') { res.writeHead(301, { location: '/map/' }); return res.end(); }
  // SEO: single page app, sitemap and robots are static.
  // /api/ out of index.
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  }
  if (req.url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    return res.end(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + `  <url>\n    <loc>${SITE_ORIGIN}/map/</loc>\n    <changefreq>daily</changefreq>\n  </url>\n`
      + `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n`
      + `    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n`
      + '    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>\n'
      + '</urlset>\n'
    );
  }
  serveStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`terraria-status listening on http://${HOST}:${PORT}`);
  SERVER.sprites = { item: hasSprites('item'), buff: hasSprites('buff'), npc: hasSprites('npc') };
  loadModBossIcons();
  fastLoop(); diskLoop(); worldLoop();
  feed.start();
  setTimeout(playerLoop, 3000); // let the first inspect land so `online` is known

});
