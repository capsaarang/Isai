'use strict';
/* Isai: personal music and podcast player. All data stays on this device. */

const VERSION = '1.2.0';
const DEFAULT_JAMENDO = '339d4597';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="icon ${cls}"><use href="#i-${n}"/></svg>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}
function fmtLong(s) {
  if (!s) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function relDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const days = Math.floor((now - d) / 864e5);
  if (days < 1 && d.getDate() === now.getDate()) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function parseDur(v) {
  if (v == null || v === '') return 0;
  v = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const p = v.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}
function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>|<\/p>/gi, '\n'), 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- storage ---------- */
const DB = {
  db: null, name: 'isai',
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { for (const n of ['tracks', 'blobs', 'art', 'kv']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => res(rq && 'result' in rq ? rq.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage aborted'));
    });
  },
  get(s, k) { return this.req(s, 'readonly', st => st.get(k)); },
  put(s, k, v) { return this.req(s, 'readwrite', st => st.put(v, k)); },
  del(s, k) { return this.req(s, 'readwrite', st => st.delete(k)); },
  all(s) { return this.req(s, 'readonly', st => st.getAll()); },
};
const KV = {
  get: k => DB.get('kv', k),
  set: (k, v) => DB.put('kv', k, v),
};

/* ---------- state ---------- */
const S = {
  tracks: [],
  liked: new Set(),
  playlists: [],
  podcasts: [],
  progress: {},
  recent: [],
  radioFavs: [],
  epDl: {},
  downloading: new Set(),
  settings: { jamendo: DEFAULT_JAMENDO, relay: '' },
  lists: {},
  tab: 'home',
  stacks: { home: [], search: [], discover: [], podcasts: [], library: [] },
  libTab: 'songs',
  podTab: 'new',
  discTab: 'archive',
  disc: {},
  q: '',
  feedCache: {},
};
const saveKV = {
  liked: () => KV.set('liked', [...S.liked]),
  playlists: () => KV.set('playlists', S.playlists),
  podcasts: () => KV.set('podcasts', S.podcasts),
  progress: () => KV.set('progress', S.progress),
  recent: () => KV.set('recent', S.recent),
  radioFavs: () => KV.set('radioFavs', S.radioFavs),
  epDl: () => KV.set('epDl', S.epDl),
  settings: () => KV.set('settings', S.settings),
};
const trackById = id => S.tracks.find(t => t.id === id);

/* ---------- playable items ---------- */
const songP = t => ({ type: 'song', key: 'song:' + t.id, id: t.id, title: t.title, sub: t.artist, artist: t.artist, album: t.album, artId: t.hasArt ? t.id : null, duration: t.duration });
const epP = (e, pod) => ({ type: 'episode', key: 'ep:' + e.id, id: e.id, title: e.title, sub: pod.title, podId: pod.id, url: e.url, artUrl: e.image || pod.art, duration: e.duration, pubDate: e.pubDate, desc: e.desc });
const radioP = s => ({ type: 'radio', key: 'radio:' + s.stationuuid, id: s.stationuuid, title: (s.name || 'Station').trim(), sub: [s.country, (s.tags || '').split(',').filter(Boolean).slice(0, 2).join(', ')].filter(Boolean).join(' · '), url: s.url_resolved, artUrl: s.favicon || null });
const jamP = t => ({ type: 'remote', source: 'jamendo', key: 'jam:' + t.id, id: String(t.id), title: t.name, sub: t.artist_name, artist: t.artist_name, album: t.album_name || 'Jamendo', url: t.audio, dl: t.audiodownload_allowed && t.audiodownload ? t.audiodownload : t.audio, artUrl: t.image || t.album_image || null, duration: t.duration });

/* ---------- artwork ---------- */
const PAL = [['#FAC775', '#412402', 38], ['#85B7EB', '#042C53', 210], ['#ED93B1', '#4B1528', 335], ['#97C459', '#173404', 90], ['#AFA9EC', '#26215C', 248], ['#5DCAA5', '#04342C', 160], ['#F0997B', '#4A1B0C', 15], ['#F7C1C1', '#501313', 0]];
const palFor = s => PAL[parseInt(hash(String(s || 'x')), 36) % PAL.length];
function initials(s) {
  const w = String(s || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}
const artCache = new Map();
async function artURL(id) {
  if (!id) return null;
  if (artCache.has(id)) return artCache.get(id);
  const b = await DB.get('art', id).catch(() => null);
  const u = b ? URL.createObjectURL(b) : null;
  artCache.set(id, u);
  return u;
}
function artHTML(p, cls = '', px = 46, iconName = null) {
  const label = p.album && p.type === 'song' ? p.album : p.title;
  const [bg, fg] = palFor(label);
  const inner = iconName ? icon(iconName) : esc(initials(label));
  const img = p.artUrl ? `<img src="${esc(p.artUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<div class="art ${cls}" style="background:${bg};color:${fg};font-size:${Math.round(px * 0.34)}px" ${p.artId ? `data-art="${esc(p.artId)}"` : ''}>${inner}${img}</div>`;
}
function hydrateArt(root = document) {
  root.querySelectorAll('[data-art]').forEach(async el => {
    if (el.querySelector('img')) return;
    const u = await artURL(el.dataset.art);
    if (u && !el.querySelector('img')) { const i = new Image(); i.src = u; i.alt = ''; el.appendChild(i); }
  });
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------- network ---------- */
async function fetchVia(url, as = 'text') {
  const tryOne = async u => {
    const r = await fetch(u, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return as === 'blob' ? r.blob() : as === 'json' ? r.json() : r.text();
  };
  try { return await tryOne(url); }
  catch (e) {
    const relay = (S.settings.relay || '').trim().replace(/\/+$/, '');
    if (!relay) { const err = new Error('relay-needed'); err.cause = e; throw err; }
    return tryOne(relay + '/?url=' + encodeURIComponent(url));
  }
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- player ---------- */
const audio = $('#audio');
const Player = {
  queue: [], idx: -1, original: null, context: '',
  shuffle: false, repeat: 'off', speed: 1, ready: false,
  objURL: null, sleepAt: 0, sleepEnd: false,
  get cur() { return this.queue[this.idx] || null; },

  async play(list, i = 0, context = '') {
    list = list.filter(Boolean);
    if (!list.length) return;
    this.context = context;
    if (this.shuffle && list.length > 1) {
      const first = list[i];
      const rest = list.filter((_, j) => j !== i);
      this.original = list.slice();
      this.queue = [first, ...shuffleArr(rest)];
      this.idx = 0;
    } else { this.original = null; this.queue = list.slice(); this.idx = i; }
    await this.load(true);
  },
  async load(autoplay = true) {
    const p = this.cur;
    if (!p) return;
    this.ready = false;
    if (this.objURL) { URL.revokeObjectURL(this.objURL); this.objURL = null; }
    let src = null;
    try {
      if (p.type === 'song') {
        const b = await DB.get('blobs', p.id);
        if (!b) throw new Error('missing');
        src = this.objURL = URL.createObjectURL(b);
      } else if (p.type === 'episode' && S.epDl[p.id]) {
        const b = await DB.get('blobs', 'ep:' + p.id);
        src = b ? (this.objURL = URL.createObjectURL(b)) : p.url;
      } else src = p.url;
    } catch { toast("Couldn't open this song"); return; }
    audio.src = src;
    const rate = p.type === 'episode' ? this.speed : 1;
    audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
    if (p.type === 'episode') {
      const pr = S.progress[p.id];
      if (pr && !pr.done && pr.t > 5) {
        audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = pr.t; } catch { } }, { once: true });
      }
    }
    this.ready = true;
    if (autoplay) { audio.play().catch(() => { }); addRecent(p); }
    updatePlayerUI(); updateMediaSession(); saveState();
    markPlayingRows();
    Together.localEvent();
  },
  toggle() {
    if (!this.cur) return;
    if (!this.ready) { this.load(true); return; }
    if (audio.paused) audio.play().catch(() => toast("Couldn't play")); else audio.pause();
  },
  next(auto = false) {
    if (!this.cur) return;
    if (auto && this.repeat === 'one' && this.cur.type !== 'radio') { audio.currentTime = 0; audio.play(); return; }
    if (this.idx < this.queue.length - 1) { this.idx++; this.load(true); }
    else if (this.repeat === 'all' && this.queue.length) { this.idx = 0; this.load(true); }
    else if (auto) { audio.pause(); updatePlayerUI(); }
  },
  prev() {
    if (!this.cur) return;
    if (this.cur.type !== 'radio' && audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (this.idx > 0) { this.idx--; this.load(true); }
    else { audio.currentTime = 0; }
  },
  skip(sec) { if (isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration - 1, audio.currentTime + sec)); },
  addNext(p) {
    if (!this.cur) return this.play([p], 0, 'Queue');
    this.queue.splice(this.idx + 1, 0, p); saveState(); toast('Playing next');
  },
  addQueue(p) {
    if (!this.cur) return this.play([p], 0, 'Queue');
    this.queue.push(p); saveState(); toast('Added to queue');
  },
  setShuffle(on) {
    this.shuffle = on;
    const cur = this.cur;
    if (!cur) return;
    if (on) {
      this.original = this.queue.slice();
      const rest = this.queue.filter((_, j) => j !== this.idx);
      this.queue = [cur, ...shuffleArr(rest)]; this.idx = 0;
    } else if (this.original) {
      const i = this.original.findIndex(x => x.key === cur.key);
      this.queue = this.original; this.idx = i >= 0 ? i : 0; this.original = null;
    }
    saveState();
  },
};
function shuffleArr(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

let lastSave = 0, lastProg = 0;
function saveState() {
  KV.set('player', { queue: Player.queue.slice(0, 300), idx: Player.idx, context: Player.context, time: audio.currentTime || 0, shuffle: Player.shuffle, repeat: Player.repeat, speed: Player.speed }).catch(() => { });
}
function addRecent(p) {
  S.recent = [p, ...S.recent.filter(x => x.key !== p.key)].slice(0, 20);
  saveKV.recent();
}

audio.addEventListener('timeupdate', () => {
  const p = Player.cur;
  updateProgressUI();
  const now = Date.now();
  if (p && p.type === 'episode' && now - lastProg > 5000 && audio.currentTime > 0) {
    lastProg = now;
    S.progress[p.id] = { t: audio.currentTime, d: audio.duration || p.duration || 0, done: false, at: now };
    saveKV.progress();
  }
  if (now - lastSave > 15000) { lastSave = now; saveState(); }
  if (Player.sleepAt && now >= Player.sleepAt) { Player.sleepAt = 0; audio.pause(); toast('Sleep timer: paused'); updateSleepLabel(); }
});
audio.addEventListener('play', () => { if (Together.isSilent()) return; updatePlayerUI(); Together.localEvent(); });
audio.addEventListener('pause', () => { if (Together.isSilent()) return; updatePlayerUI(); saveState(); Together.localEvent(); });
audio.addEventListener('seeked', () => Together.localEvent());
audio.addEventListener('loadedmetadata', () => { updateProgressUI(); updateMediaSession(); });
audio.addEventListener('ended', () => {
  if (Together.isSilent()) return;
  const p = Player.cur;
  if (p && p.type === 'episode') { S.progress[p.id] = { t: 0, d: audio.duration, done: true, at: Date.now() }; saveKV.progress(); }
  if (Player.sleepEnd) { Player.sleepEnd = false; updateSleepLabel(); toast('Sleep timer: stopped'); updatePlayerUI(); return; }
  Player.next(true);
});
audio.addEventListener('error', () => {
  if (!audio.src || !Player.ready || Together.isSilent()) return;
  const p = Player.cur;
  toast(p && p.type === 'radio' ? "This station isn't responding" : "Couldn't play this. Skipping");
  if (p && p.type !== 'radio' && Player.idx < Player.queue.length - 1) setTimeout(() => Player.next(), 800);
});

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const p = Player.cur; if (!p) return;
  const set = art => {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: p.title, artist: p.sub || '', album: p.album || Player.context || 'Isai',
        artwork: art ? [{ src: art, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch { }
  };
  if (p.artId) artURL(p.artId).then(set); else set(p.artUrl);
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { } };
  h('play', () => audio.play());
  h('pause', () => audio.pause());
  h('previoustrack', () => Player.prev());
  h('nexttrack', () => Player.next());
  h('seekbackward', p.type === 'radio' ? null : d => Player.skip(-(d.seekOffset || 15)));
  h('seekforward', p.type === 'radio' ? null : d => Player.skip(d.seekOffset || 30));
  h('seekto', p.type === 'radio' ? null : d => { audio.currentTime = d.seekTime; });
}

/* ---------- player UI ---------- */
function likeBtnHTML(p) {
  if (!p) return '';
  if (p.type === 'song') { const on = S.liked.has(p.id); return `<span class="${on ? 'acc' : ''}">${icon(on ? 'heart-f' : 'heart')}</span>`; }
  if (p.type === 'radio') { const on = S.radioFavs.some(s => s.key === p.key); return `<span class="${on ? 'acc' : ''}">${icon(on ? 'star-f' : 'star')}</span>`; }
  if (p.type === 'remote') return icon('download');
  if (p.type === 'episode') return S.epDl[p.id] ? `<span class="acc">${icon('check')}</span>` : icon('download');
  return '';
}
function updatePlayerUI() {
  const p = Player.cur;
  const mini = $('#mini');
  if (!p) { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  const [, , hue] = palFor(p.album && p.type === 'song' ? p.album : p.title);
  mini.style.background = `hsl(${hue} 28% 20%)`;
  $('#np').style.setProperty('--np-bg', `hsl(${hue} 30% 14%)`);
  $('#mini-art').outerHTML = artHTML(p, '', 44).replace('class="art ', 'id="mini-art" class="art ');
  $('#mini-title').textContent = p.title;
  $('#mini-sub').innerHTML = (p.type === 'radio' ? '<span class="live">LIVE</span>' : '') + esc(p.sub || '');
  const playing = !audio.paused;
  $('#mini-play').innerHTML = icon(playing ? 'pause' : 'play');
  $('#mini-like').innerHTML = likeBtnHTML(p);
  // full player
  $('#np-from').textContent = Player.context || (p.type === 'episode' ? p.sub : 'Isai');
  $('#np-art').outerHTML = artHTML(p, 'np-art', 300).replace('class="art ', 'id="np-art" class="art ');
  $('#np-title').textContent = p.title;
  $('#np-sub').innerHTML = (p.type === 'radio' ? '<span class="live">LIVE</span>' : '') + esc(p.sub || '');
  $('#np-like').innerHTML = likeBtnHTML(p);
  $('#np-seekwrap').classList.toggle('hidden', p.type === 'radio');
  const c = $('#np-controls');
  const play = `<button class="big" data-a="toggle" aria-label="Play or pause">${icon(playing ? 'pause' : 'play', 'lg')}</button>`;
  if (p.type === 'episode') {
    c.innerHTML = `<button class="ctl" data-a="speed" aria-label="Playback speed"><span class="speed">${Player.speed}x</span></button>
      <button class="ctl" data-a="skip" data-s="-15" aria-label="Back 15 seconds">${icon('back15', 'lg')}</button>${play}
      <button class="ctl" data-a="skip" data-s="30" aria-label="Forward 30 seconds">${icon('fwd30', 'lg')}</button>
      <button class="ctl" data-a="next" aria-label="Next">${icon('next')}</button>`;
  } else {
    const rep = Player.repeat;
    c.innerHTML = `<button class="ctl ${Player.shuffle ? 'on' : ''}" data-a="shuffle" aria-label="Shuffle">${icon('shuffle')}${Player.shuffle ? '<span class="dot"></span>' : ''}</button>
      <button class="ctl" data-a="prev" aria-label="Previous">${icon('prev', 'lg')}</button>${play}
      <button class="ctl" data-a="next" aria-label="Next">${icon('next', 'lg')}</button>
      <button class="ctl ${rep !== 'off' ? 'on' : ''}" data-a="repeat" aria-label="Repeat">${icon('repeat')}${rep === 'one' ? '<span class="badge">1</span>' : ''}${rep !== 'off' ? '<span class="dot"></span>' : ''}</button>`;
  }
  hydrateArt($('#mini')); hydrateArt($('#np'));
  updateProgressUI(); updateSleepLabel();
}
let seeking = false;
function updateProgressUI() {
  const d = audio.duration, t = audio.currentTime;
  const pct = isFinite(d) && d > 0 ? (t / d) * 100 : 0;
  $('#mini-bar').style.width = pct + '%';
  if (!seeking) {
    const s = $('#np-seek');
    s.value = Math.round(pct * 10); s.style.setProperty('--p', pct + '%');
    $('#np-cur').textContent = fmt(t);
    $('#np-dur').textContent = isFinite(d) ? fmt(d) : fmt(Player.cur?.duration || 0);
  }
}
function updateSleepLabel() {
  const l = $('#np-sleep-label');
  if (Player.sleepEnd) l.textContent = 'End of track';
  else if (Player.sleepAt) l.textContent = Math.max(1, Math.ceil((Player.sleepAt - Date.now()) / 60000)) + ' min';
  else l.textContent = 'Sleep';
}
function markPlayingRows() {
  const k = Player.cur?.key;
  document.querySelectorAll('.row[data-key]').forEach(r => r.classList.toggle('playing', r.dataset.key === k));
}

/* ---------- layers (back button handling) ---------- */
const layers = [];
function pushLayer(type) { layers.push(type); history.pushState({ l: layers.length }, ''); }
window.addEventListener('popstate', e => {
  const target = (e.state && e.state.l) || 0;
  let viewPopped = false;
  while (layers.length > target) {
    const top = layers.pop();
    if (top === 'sheet') hideSheet();
    else if (top === 'np') $('#np').classList.remove('open');
    else if (top === 'view') { S.stacks[S.tab].pop(); viewPopped = true; }
  }
  if (viewPopped) render();
});
function openNP() { if (!Player.cur) return; $('#np').classList.add('open'); pushLayer('np'); }
function closeTop() { history.back(); }

function openSheet(html) {
  const sh = $('#sheet');
  const wasOpen = sh.classList.contains('on');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  sh.scrollTop = 0;
  hydrateArt(sh);
  if (!wasOpen) { sh.classList.add('on'); $('#scrim').classList.add('on'); pushLayer('sheet'); }
}
function hideSheet() { $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on'); sheetKind = ''; }
function closeSheet() { if ($('#sheet').classList.contains('on')) history.back(); }

/* ---------- navigation ---------- */
function go(view, params = {}) {
  S.stacks[S.tab].push({ view, params });
  pushLayer('view');
  render();
}
function setTab(tab) {
  if (S.tab === tab) {
    const n = S.stacks[tab].length;
    if (n) { history.go(-n); return; }
    $('#view').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const n = layers.length;
  S.stacks[S.tab] = [];
  S.tab = tab;
  if (n) { layers.splice(0); hideSheet(); $('#np').classList.remove('open'); history.go(-n); setTimeout(render, 30); } else render();
}

let renderToken = 0;
async function render() {
  const tok = ++renderToken;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const top = S.stacks[S.tab].at(-1);
  const name = top ? top.view : S.tab;
  const fn = Views[name] || Views.home;
  S.lists = {};
  let html;
  try { html = await fn(top ? top.params : {}); }
  catch (e) { console.error(e); html = `<div class="empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`; }
  if (tok !== renderToken) return;
  const v = $('#view');
  v.innerHTML = html;
  v.scrollTop = 0;
  hydrateArt(v);
  markPlayingRows();
  if (fn.after) fn.after(top ? top.params : {});
}
function rerenderKeepScroll() {
  const v = $('#view'), y = v.scrollTop;
  render().then(() => { v.scrollTop = y; });
}

/* ---------- list rendering helpers ---------- */
function reg(items, ctx) { const id = 'l' + Object.keys(S.lists).length; S.lists[id] = { items, ctx }; return id; }
function rowsHTML(items, ctx, opts = {}) {
  const L = reg(items, ctx);
  return `<div class="list">${items.map((p, i) => {
    const sub = p.type === 'radio' ? esc(p.sub || 'Radio') : esc(p.sub || '') + (opts.dur && p.duration ? ' · ' + fmt(p.duration) : '');
    const right = p.type === 'radio'
      ? `<button class="more" data-a="fav-radio" data-l="${L}" data-i="${i}" aria-label="Favorite">${S.radioFavs.some(s => s.key === p.key) ? `<span class="acc">${icon('star-f', 'sm')}</span>` : icon('star', 'sm')}</button>`
      : `<button class="more" data-a="more" data-l="${L}" data-i="${i}" aria-label="More">${icon('dotsv', 'sm')}</button>`;
    return `<div class="row" data-key="${esc(p.key)}"><button class="row" style="padding:0;min-height:0;flex:1;min-width:0" data-a="play" data-l="${L}" data-i="${i}">
      ${artHTML(p, opts.round ? 'round' : '', 46, p.type === 'radio' && !p.artUrl ? 'radio' : null)}
      <div class="meta"><div class="t ellipsis">${esc(p.title)}</div><div class="s ellipsis">${p.type === 'song' && S.liked.has(p.id) ? `<span class="acc" style="margin-right:4px">${icon('heart-f', 'sm').replace('class="icon', 'style="width:12px;height:12px;vertical-align:-1px" class="icon')}</span>` : ''}${sub}</div></div>
    </button>${right}</div>`;
  }).join('')}</div>`;
}
function epRowsHTML(items, ctx) {
  const L = reg(items, ctx);
  return `<div class="list">${items.map((p, i) => {
    const pr = S.progress[p.id];
    const dl = S.downloading.has(p.id) ? '<div class="spinner" style="width:18px;height:18px;margin:0;border-width:2px"></div>'
      : S.epDl[p.id] ? `<span class="acc">${icon('check', 'sm')}</span>` : icon('download', 'sm');
    const left = pr && pr.done ? 'Played' : pr && pr.t && pr.d ? fmtLong(pr.d - pr.t) + ' left' : fmtLong(p.duration);
    return `<div class="row ep" data-key="${esc(p.key)}">
      <button style="display:flex;gap:12px;flex:1;min-width:0;text-align:left" data-a="play" data-l="${L}" data-i="${i}">
        ${artHTML(p, '', 46)}
        <div class="meta"><div class="s">${esc(relDate(p.pubDate))}${left ? ' · ' + esc(left) : ''}</div>
          <div class="t" style="${pr && pr.done ? 'color:var(--muted)' : ''}">${esc(p.title)}</div>
          <div class="s ellipsis">${esc(p.sub)}</div>
          ${pr && !pr.done && pr.t && pr.d ? `<div class="progress-mini"><i style="width:${Math.min(100, (pr.t / pr.d) * 100)}%"></i></div>` : ''}
        </div></button>
      <div style="display:flex;flex-direction:column;align-items:center">
        <button class="more" data-a="dl-ep" data-l="${L}" data-i="${i}" aria-label="Download">${dl}</button>
        <button class="more" data-a="more" data-l="${L}" data-i="${i}" aria-label="More">${icon('dotsv', 'sm')}</button>
      </div></div>`;
  }).join('')}</div>`;
}
function topbar(title, { back = false, right = '' } = {}) {
  return `<div class="topbar">${back ? `<button class="iconbtn" data-a="back" aria-label="Back">${icon('back')}</button>` : ''}
    ${back ? `<h2 class="ellipsis">${esc(title)}</h2>` : `<h1>${esc(title)}</h1>`}${right}</div>`;
}
const emptyHTML = (ic, h, p, btns = '') => `<div class="empty">${icon(ic)}<h3>${esc(h)}</h3><p>${esc(p)}</p>${btns}</div>`;

/* ---------- library helpers ---------- */
const sortTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
function songsSorted() { return S.tracks.slice().sort(sortTitle); }
function albumsList() {
  const m = new Map();
  for (const t of S.tracks) {
    const k = t.album;
    if (!m.has(k)) m.set(k, { name: t.album, artist: t.artist, tracks: [] });
    m.get(k).tracks.push(t);
  }
  for (const a of m.values()) {
    a.tracks.sort((x, y) => (x.track || 999) - (y.track || 999) || sortTitle(x, y));
    const artists = new Set(a.tracks.map(t => t.artist));
    if (artists.size > 1) a.artist = 'Various artists';
    a.artId = (a.tracks.find(t => t.hasArt) || {}).id || null;
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function artistsList() {
  const m = new Map();
  for (const t of S.tracks) { if (!m.has(t.artist)) m.set(t.artist, []); m.get(t.artist).push(t); }
  return [...m.entries()].map(([name, tracks]) => ({ name, tracks, artId: (tracks.find(t => t.hasArt) || {}).id || null })).sort((a, b) => a.name.localeCompare(b.name));
}
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
function continueEpisodes() {
  const out = [];
  for (const pod of S.podcasts) for (const e of pod.episodes) {
    const pr = S.progress[e.id];
    if (pr && !pr.done && pr.t > 10) out.push({ p: epP(e, pod), at: pr.at || 0 });
  }
  for (const id in S.epDl) { const pr = S.progress[id]; if (pr && !pr.done && pr.t > 10 && !out.some(o => o.p.id === id)) out.push({ p: S.epDl[id], at: pr.at || 0 }); }
  return out.sort((a, b) => b.at - a.at).map(o => o.p);
}

/* ---------- views ---------- */
const Views = {};

Views.home = () => {
  let h = `<div class="topbar" style="margin-bottom:6px"><button class="me-btn" data-a="switch-profile" aria-label="Switch profile">${avatarHTML(ME, 34)}</button><span style="flex:1"></span>
    <button class="iconbtn" data-a="together" aria-label="Listen together">${icon('users')}</button>
    <button class="iconbtn" data-a="import" aria-label="Add songs">${icon('upload')}</button>
    <button class="iconbtn" data-a="go" data-v="settings" aria-label="Settings">${icon('gear')}</button></div>
    <h1 class="welcome">Welcome to the world of Isai</h1>`;
  if (!S.tracks.length && !S.podcasts.length && !S.recent.length) {
    return h + emptyHTML('music', 'Let\'s get started', 'Add songs from your Rajan folder, follow podcasts, or explore free music and radio.',
      `<div style="display:flex;flex-direction:column;gap:10px;align-items:center">
        <button class="btn primary" data-a="import">${icon('upload', 'sm')} Add songs</button>
        <button class="btn ghost" data-a="tab" data-t="podcasts">${icon('mic', 'sm')} Find podcasts</button>
        <button class="btn ghost" data-a="tab" data-t="discover">${icon('compass', 'sm')} Discover free music</button></div>`);
  }
  const tiles = [`<button class="tile" data-a="go" data-v="playlist" data-p="liked">${artHTML({ title: 'Liked' }, '', 52, 'heart-f').replace(/background:[^;]+;color:[^;]+/, 'background:#EF9F27;color:#2b1700')}<span class="ellipsis">Liked songs</span></button>`,
    `<button class="tile" data-a="go" data-v="downloads">${artHTML({ title: 'Downloads' }, '', 52, 'download').replace(/background:[^;]+;color:[^;]+/, 'background:#85B7EB;color:#042C53')}<span class="ellipsis">Downloads</span></button>`];
  for (const pl of S.playlists.slice(0, 6)) tiles.push(`<button class="tile" data-a="go" data-v="playlist" data-p="${esc(pl.id)}">${artHTML(plCover(pl), '', 52)}<span class="ellipsis">${esc(pl.name)}</span></button>`);
  h += `<div class="tiles">${tiles.join('')}</div>`;

  const cont = continueEpisodes().slice(0, 3);
  if (cont.length) h += `<div class="section-title">Continue listening</div>` + epRowsHTML(cont, 'Continue listening');

  if (S.recent.length) {
    const L = reg(S.recent, 'Recently played');
    h += `<div class="section-title">Recently played</div><div class="hscroll">${S.recent.map((p, i) =>
      `<button class="card ${p.type === 'radio' ? 'round' : ''}" data-a="play-one" data-l="${L}" data-i="${i}">${artHTML(p, '', 128, p.type === 'radio' && !p.artUrl ? 'radio' : null)}<div class="t ellipsis">${esc(p.title)}</div><div class="s ellipsis">${esc(p.sub || '')}</div></button>`).join('')}</div>`;
  }
  if (S.radioFavs.length) h += `<div class="section-title">Your stations</div>` + rowsHTML(S.radioFavs, 'Your stations');
  const recentAdded = S.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 8).map(songP);
  if (recentAdded.length) h += `<div class="section-title">Recently added <button data-a="tab" data-t="library">See all</button></div>` + rowsHTML(recentAdded, 'Recently added');
  return h;
};
function plCover(pl) {
  const t = pl.ids.map(trackById).find(t => t && t.hasArt);
  return { title: pl.name, artId: t ? t.id : null };
}

Views.search = () => {
  return topbar('Search') + `<div class="search">${icon('search')}<input id="q" type="search" placeholder="Songs, artists, albums, episodes" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search"></div><div id="results"></div>`;
};
Views.search.after = () => {
  const inp = $('#q');
  const run = () => { S.q = inp.value; renderSearchResults(); };
  inp.addEventListener('input', run);
  renderSearchResults();
};
function renderSearchResults() {
  const box = $('#results'); if (!box) return;
  S.lists = {};
  const q = S.q.trim().toLowerCase();
  if (!q) {
    box.innerHTML = `<div class="notice">Search looks through your songs, playlists, and podcast episodes. To find new music, use <b>Discover</b>. To find new shows, use <b>Podcasts</b>.</div>`;
    return;
  }
  const has = s => String(s || '').toLowerCase().includes(q);
  const songs = S.tracks.filter(t => has(t.title) || has(t.artist) || has(t.album)).sort(sortTitle).slice(0, 50).map(songP);
  const artists = artistsList().filter(a => has(a.name)).slice(0, 8);
  const albums = albumsList().filter(a => has(a.name)).slice(0, 8);
  const pls = S.playlists.filter(p => has(p.name));
  const eps = [];
  for (const pod of S.podcasts) for (const e of pod.episodes) if (has(e.title) || has(pod.title)) eps.push(epP(e, pod));
  let h = '';
  if (artists.length || albums.length || pls.length) {
    h += `<div class="hscroll" style="margin-bottom:8px">` +
      artists.map(a => `<button class="card round" data-a="go" data-v="artist" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 128)}<div class="t ellipsis">${esc(a.name)}</div><div class="s">Artist</div></button>`).join('') +
      albums.map(a => `<button class="card" data-a="go" data-v="album" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 128)}<div class="t ellipsis">${esc(a.name)}</div><div class="s ellipsis">Album · ${esc(a.artist)}</div></button>`).join('') +
      pls.map(p => `<button class="card" data-a="go" data-v="playlist" data-p="${esc(p.id)}">${artHTML(plCover(p), '', 128)}<div class="t ellipsis">${esc(p.name)}</div><div class="s">Playlist</div></button>`).join('') + `</div>`;
  }
  if (songs.length) h += `<div class="section-title">Songs</div>` + rowsHTML(songs, 'Search');
  if (eps.length) h += `<div class="section-title">Episodes</div>` + epRowsHTML(eps.slice(0, 30), 'Search');
  if (!h) h = emptyHTML('search', `No results for "${S.q}"`, 'Check the spelling, or try Discover to find new music.');
  box.innerHTML = h;
  hydrateArt(box); markPlayingRows();
}

Views.library = () => {
  const right = `<button class="iconbtn" data-a="import" aria-label="Add songs">${icon('plus')}</button>`;
  const chips = [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']]
    .map(([k, l]) => `<button class="chip ${S.libTab === k ? 'on' : ''}" data-a="libtab" data-t="${k}">${l}</button>`).join('');
  let h = topbar('Your library', { right }) + `<div class="chips">${chips}</div>`;
  if (S.libTab === 'playlists') {
    h += `<button class="row" data-a="new-playlist"><div class="art" style="width:46px;height:46px;background:var(--card);color:var(--text)">${icon('plus')}</div><div class="meta"><div class="t">New playlist</div></div></button>`;
    h += `<button class="row" data-a="go" data-v="playlist" data-p="liked"><div class="art" style="width:46px;height:46px;background:#EF9F27;color:#2b1700">${icon('heart-f')}</div><div class="meta"><div class="t">Liked songs</div><div class="s">${S.liked.size} songs</div></div></button>`;
    h += S.playlists.map(pl => `<button class="row" data-a="go" data-v="playlist" data-p="${esc(pl.id)}">${artHTML(plCover(pl), '', 46)}<div class="meta"><div class="t ellipsis">${esc(pl.name)}</div><div class="s">Playlist · ${pl.ids.length} songs</div></div></button>`).join('');
    return h;
  }
  if (!S.tracks.length) return h + emptyHTML('music', 'Add your first songs', 'Pick songs from your Rajan folder. They get copied into Isai so they play offline.', `<button class="btn primary" data-a="import">${icon('upload', 'sm')} Add songs</button>`);
  if (S.libTab === 'songs') {
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span class="muted" style="font-size:13px">${S.tracks.length} songs</span><button class="btn small primary" data-a="shuffle-all">${icon('shuffle', 'sm')} Shuffle</button></div>`;
    h += rowsHTML(songsSorted().map(songP), 'Your library', { dur: true });
  } else if (S.libTab === 'albums') {
    h += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px">${albumsList().map(a =>
      `<button class="card" style="width:auto" data-a="go" data-v="album" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 140).replace('class="art ', 'style="width:100%;height:auto;aspect-ratio:1" class="art ')}<div class="t ellipsis">${esc(a.name)}</div><div class="s ellipsis">${esc(a.artist)}</div></button>`).join('')}</div>`;
  } else {
    h += artistsList().map(a => `<button class="row" data-a="go" data-v="artist" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 46).replace('class="art ', 'style="width:46px;height:46px;border-radius:50%" class="art ')}<div class="meta"><div class="t ellipsis">${esc(a.name)}</div><div class="s">${a.tracks.length} songs</div></div></button>`).join('');
  }
  return h;
};

function heroHTML(p, title, sub, round = false) {
  return `<div class="hero">${artHTML(p, '', 200).replace('class="art ', `style="width:200px;height:200px;${round ? 'border-radius:50%' : ''}" class="art `)}<h2>${esc(title)}</h2><div class="muted" style="font-size:14px">${esc(sub)}</div></div>`;
}
function playBar(L, extra = '') {
  return `<div class="actions">${extra}<button class="iconbtn" data-a="shuffle-list" data-l="${L}" aria-label="Shuffle">${icon('shuffle')}</button><button class="playfab" data-a="play" data-l="${L}" data-i="0" aria-label="Play">${icon('play', 'lg')}</button></div>`;
}
Views.album = name => {
  const a = albumsList().find(x => x.name === name);
  if (!a) return topbar('Album', { back: true }) + emptyHTML('album', 'Album not found', 'It may have been removed.');
  const items = a.tracks.map(songP);
  const L = reg(items, a.name);
  return topbar('', { back: true }) + heroHTML({ title: a.name, artId: a.artId }, a.name, `${a.artist} · ${items.length} song${items.length === 1 ? '' : 's'}`) + playBar(L) + rowsHTML(items, a.name, { dur: true });
};
Views.artist = name => {
  const tracks = S.tracks.filter(t => t.artist === name).sort(sortTitle);
  const items = tracks.map(songP);
  const L = reg(items, name);
  const albums = albumsList().filter(a => a.tracks.some(t => t.artist === name));
  let h = topbar('', { back: true }) + heroHTML({ title: name, artId: (tracks.find(t => t.hasArt) || {}).id }, name, `${items.length} song${items.length === 1 ? '' : 's'}`, true) + playBar(L) + rowsHTML(items, name, { dur: true });
  if (albums.length) h += `<div class="section-title">Albums</div><div class="hscroll">${albums.map(a => `<button class="card" data-a="go" data-v="album" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 128)}<div class="t ellipsis">${esc(a.name)}</div></button>`).join('')}</div>`;
  return h;
};
Views.playlist = id => {
  let name, ids, pl = null;
  if (id === 'liked') { name = 'Liked songs'; ids = [...S.liked].reverse(); }
  else { pl = S.playlists.find(p => p.id === id); if (!pl) return topbar('Playlist', { back: true }) + emptyHTML('list', 'Playlist not found', ''); name = pl.name; ids = pl.ids; }
  const items = ids.map(trackById).filter(Boolean).map(songP);
  const L = reg(items, name);
  const cover = id === 'liked' ? artHTML({ title: name }, '', 200, 'heart-f').replace(/background:[^;]+;color:[^;]+/, 'background:#EF9F27;color:#2b1700').replace('class="art ', 'style="width:200px;height:200px" class="art ') : null;
  let h = topbar('', { back: true });
  h += cover ? `<div class="hero">${cover}<h2>${esc(name)}</h2><div class="muted" style="font-size:14px">${items.length} songs</div></div>` : heroHTML(plCover(pl), name, `Playlist · ${items.length} song${items.length === 1 ? '' : 's'}`);
  const extra = pl ? `<button class="iconbtn" data-a="pl-more" data-p="${esc(pl.id)}" aria-label="Playlist options">${icon('dotsv')}</button>` : '';
  h += items.length ? playBar(L, extra) + rowsHTML(items, name, { dur: true, plId: pl ? pl.id : null }).replace(/data-a="more"/g, `data-a="more" data-pl="${esc(pl ? pl.id : 'liked')}"`) :
    `<div class="actions">${extra}</div>` + emptyHTML(id === 'liked' ? 'heart' : 'list', id === 'liked' ? 'Songs you like show up here' : 'This playlist is empty', id === 'liked' ? 'Tap the heart on any song.' : 'Use the menu on any song to add it here.');
  return h;
};
Views.downloads = () => {
  const items = Object.values(S.epDl).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return topbar('Downloads', { back: true }) + (items.length ? epRowsHTML(items, 'Downloads') : emptyHTML('download', 'No downloaded episodes', 'Tap the download button on any episode to keep it for offline listening.'));
};

/* ----- Podcasts ----- */
Views.podcasts = () => {
  const right = `<button class="iconbtn" data-a="refresh-pods" aria-label="Refresh">${icon('refresh')}</button><button class="iconbtn" data-a="go" data-v="podsearch" aria-label="Find podcasts">${icon('search')}</button>`;
  let h = topbar('Podcasts', { right });
  if (!S.podcasts.length) {
    return h + emptyHTML('mic', 'Follow your first show', 'Search any public podcast. New episodes show up here automatically.', `<button class="btn primary" data-a="go" data-v="podsearch">${icon('search', 'sm')} Find podcasts</button>`) + relayNoticeIfNeeded();
  }
  const chips = [['new', 'New'], ['shows', 'Shows'], ['dl', 'Downloaded']].map(([k, l]) => `<button class="chip ${S.podTab === k ? 'on' : ''}" data-a="podtab" data-t="${k}">${l}</button>`).join('');
  h += `<div class="chips">${chips}</div>`;
  if (S.podTab === 'shows') {
    h += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px">${S.podcasts.map(pod =>
      `<button class="card" style="width:auto" data-a="go" data-v="show" data-p="${esc(pod.id)}">${artHTML({ title: pod.title, artUrl: pod.art }, '', 140).replace('class="art ', 'style="width:100%;height:auto;aspect-ratio:1" class="art ')}<div class="t ellipsis">${esc(pod.title)}</div><div class="s ellipsis">${esc(pod.author || '')}</div></button>`).join('')}
      <button class="card" style="width:auto" data-a="go" data-v="podsearch"><div class="art" style="width:100%;aspect-ratio:1;border:1.5px dashed #555;background:transparent;color:var(--muted)">${icon('plus', 'lg')}</div><div class="t">Add show</div></button></div>`;
  } else if (S.podTab === 'dl') {
    const items = Object.values(S.epDl).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    h += items.length ? epRowsHTML(items, 'Downloads') : emptyHTML('download', 'Nothing downloaded yet', 'Downloaded episodes play without internet.');
  } else {
    h += `<div class="hscroll" style="margin-bottom:6px">${S.podcasts.map(pod => `<button class="card" style="width:64px" data-a="go" data-v="show" data-p="${esc(pod.id)}">${artHTML({ title: pod.title, artUrl: pod.art }, '', 64).replace('class="art ', 'style="width:64px;height:64px" class="art ')}</button>`).join('')}
      <button class="card" style="width:64px" data-a="go" data-v="podsearch"><div class="art" style="width:64px;height:64px;border:1.5px dashed #555;background:transparent;color:var(--muted)">${icon('plus')}</div></button></div>`;
    const all = [];
    for (const pod of S.podcasts) for (const e of pod.episodes.slice(0, 15)) all.push(epP(e, pod));
    all.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
    h += `<div class="section-title">New episodes</div>` + epRowsHTML(all.slice(0, 60), 'New episodes');
  }
  return h;
};
Views.podcasts.after = () => refreshPodcasts(false);
function relayNoticeIfNeeded() {
  return S.settings.relay ? '' : `<div class="notice">Some podcasts block apps from reading their feed directly. If a show won't load, set up the free relay in <b>Settings</b> (one time, about 5 minutes).</div>`;
}

Views.podsearch = () => topbar('Find podcasts', { back: true }) +
  `<form data-f="podsearch"><div class="search">${icon('search')}<input id="pq" type="search" placeholder="Show name or topic" value="${esc(S.podQ || '')}" autocomplete="off" enterkeyhint="search"></div></form>
   <div class="chips">${['Finance', 'Product management', 'Tech news', 'Tamil', 'Kannada', 'History', 'Comedy', 'Self improvement'].map(t => `<button class="chip" data-a="podq" data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div><div id="presults"></div>`;
Views.podsearch.after = () => { if (S.podQ) runPodSearch(S.podQ); else $('#pq').focus(); };
async function runPodSearch(q) {
  S.podQ = q;
  const box = $('#presults'); if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await getJSON('https://itunes.apple.com/search?media=podcast&entity=podcast&limit=30&term=' + encodeURIComponent(q));
    const res = (data.results || []).filter(r => r.feedUrl);
    if (!$('#presults')) return;
    if (!res.length) { box.innerHTML = emptyHTML('mic', 'No shows found', 'Try a different name.'); return; }
    S.podResults = res;
    box.innerHTML = res.map((r, i) => {
      const subbed = S.podcasts.some(p => p.feedUrl === r.feedUrl);
      return `<button class="row" data-a="pod-open" data-i="${i}">${artHTML({ title: r.collectionName, artUrl: r.artworkUrl600 || r.artworkUrl100 }, '', 56).replace('class="art ', 'style="width:56px;height:56px" class="art ')}
        <div class="meta"><div class="t ellipsis">${esc(r.collectionName)}</div><div class="s ellipsis">${esc(r.artistName || '')}${r.primaryGenreName ? ' · ' + esc(r.primaryGenreName) : ''}</div></div>${subbed ? `<span class="acc">${icon('check', 'sm')}</span>` : ''}</button>`;
    }).join('');
  } catch (e) {
    box.innerHTML = emptyHTML('mic', "Couldn't search right now", 'Check your internet connection and try again.');
  }
}

async function loadItunes(itunesId, feedUrl) {
  const data = await getJSON(`https://itunes.apple.com/lookup?id=${encodeURIComponent(itunesId)}&media=podcast&entity=podcastEpisode&limit=200`);
  const res = data.results || [];
  const show = res.find(r => r.wrapperType === 'track' && r.kind === 'podcast') || {};
  const pod = {
    id: hash(feedUrl), feedUrl, itunesId,
    title: show.collectionName || 'Podcast', author: show.artistName || '',
    art: show.artworkUrl600 || show.artworkUrl100 || '', desc: '', fetchedAt: Date.now(), episodes: [],
  };
  for (const e of res) {
    if (e.kind !== 'podcast-episode' || !e.episodeUrl) continue;
    const d = Date.parse(e.releaseDate);
    pod.episodes.push({
      id: hash(feedUrl + '|' + (e.episodeGuid || e.episodeUrl)), title: e.trackName || 'Episode', url: e.episodeUrl,
      pubDate: isNaN(d) ? 0 : d, duration: e.trackTimeMillis ? e.trackTimeMillis / 1000 : 0,
      image: e.artworkUrl600 || '', desc: stripHtml(e.description || e.shortDescription || '').slice(0, 4000),
    });
  }
  pod.episodes.sort((a, b) => b.pubDate - a.pubDate);
  if (!pod.episodes.length) throw new Error('relay-needed');
  return pod;
}
async function loadFeed(feedUrl, itunesId) {
  let xml;
  try { xml = await fetchVia(feedUrl, 'text'); }
  catch (e) { if (itunesId) return loadItunes(itunesId, feedUrl); throw e; }
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const ch = doc.querySelector('channel');
  if (!ch) throw new Error('Not a podcast feed');
  const txt = (el, sel) => { const n = [...el.children].find(c => c.nodeName === sel || c.localName === sel); return n ? n.textContent.trim() : ''; };
  const itunes = (el, name) => { const n = [...el.children].find(c => c.localName === name && /itunes/i.test(c.namespaceURI || c.prefix || '')); return n; };
  const imgEl = itunes(ch, 'image');
  const pod = {
    id: hash(feedUrl), feedUrl,
    title: txt(ch, 'title') || 'Podcast',
    author: (itunes(ch, 'author') || {}).textContent || '',
    art: (imgEl && imgEl.getAttribute('href')) || (ch.querySelector('image > url') || {}).textContent || '',
    desc: stripHtml(txt(ch, 'description')).slice(0, 600),
    fetchedAt: Date.now(), episodes: [],
  };
  for (const it of [...ch.querySelectorAll('item')].slice(0, 200)) {
    const enc = it.querySelector('enclosure');
    const url = enc && enc.getAttribute('url');
    if (!url) continue;
    const guid = txt(it, 'guid') || url;
    const eImg = itunes(it, 'image');
    const d = Date.parse(txt(it, 'pubDate'));
    pod.episodes.push({
      id: hash(feedUrl + '|' + guid), title: txt(it, 'title') || 'Episode', url,
      pubDate: isNaN(d) ? 0 : d,
      duration: parseDur((itunes(it, 'duration') || {}).textContent),
      image: eImg ? eImg.getAttribute('href') : '',
      desc: stripHtml(((itunes(it, 'summary') || {}).textContent) || txt(it, 'description') || [...it.children].find(c => c.localName === 'encoded')?.textContent || '').slice(0, 4000),
    });
  }
  pod.episodes.sort((a, b) => b.pubDate - a.pubDate);
  if (itunesId) pod.itunesId = itunesId;
  return pod;
}
function feedErrorHTML(e) {
  if (e.message === 'relay-needed') return emptyHTML('mic', "This show's feed is locked to apps", 'Set up the free relay in Settings and it will load.', `<button class="btn primary" data-a="go" data-v="settings">Open settings</button>`);
  return emptyHTML('mic', "Couldn't load this show", 'Check your connection, or try again later.');
}

Views.show = async id => {
  let pod = S.podcasts.find(p => p.id === id) || S.feedCache[id];
  if (!pod) return topbar('', { back: true }) + emptyHTML('mic', 'Show not found', '');
  const subbed = S.podcasts.some(p => p.id === id);
  if (!pod.episodes || !pod.episodes.length) {
    try { const fresh = await loadFeed(pod.feedUrl, pod.itunesId); if (!fresh.art) fresh.art = pod.art; S.feedCache[id] = fresh; pod = fresh; }
    catch (e) { return topbar('', { back: true }) + heroHTML({ title: pod.title, artUrl: pod.art }, pod.title, pod.author || '') + feedErrorHTML(e); }
  }
  const items = pod.episodes.map(e => epP(e, pod));
  let h = topbar('', { back: true }) + heroHTML({ title: pod.title, artUrl: pod.art }, pod.title, pod.author || '');
  h += `<div class="actions" style="justify-content:center"><button class="btn ${subbed ? 'ghost' : 'primary'}" data-a="${subbed ? 'unsub' : 'sub'}" data-p="${esc(id)}">${subbed ? 'Following' : 'Follow'}</button></div>`;
  if (pod.desc) h += `<p class="muted" style="font-size:13px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(pod.desc)}</p>`;
  h += `<div class="section-title">${items.length} episodes</div>` + epRowsHTML(items, pod.title);
  return h;
};

let refreshing = false;
async function refreshPodcasts(force) {
  if (refreshing || !S.podcasts.length || !navigator.onLine) return;
  const stale = S.podcasts.filter(p => force || Date.now() - (p.fetchedAt || 0) > 3600e3);
  if (!stale.length) { if (force) toast('Up to date'); return; }
  refreshing = true;
  if (force) toast('Checking for new episodes…', 0);
  let changed = 0;
  for (const p of stale) {
    try {
      const fresh = await loadFeed(p.feedUrl, p.itunesId);
      const before = p.episodes[0]?.id;
      Object.assign(p, { itunesId: fresh.itunesId || p.itunesId, title: fresh.title, author: fresh.author, art: fresh.art || p.art, desc: fresh.desc, episodes: fresh.episodes, fetchedAt: Date.now() });
      if (fresh.episodes[0]?.id !== before) changed++;
    } catch { }
  }
  refreshing = false;
  await saveKV.podcasts();
  if (force) toast(changed ? `${changed} show${changed > 1 ? 's' : ''} updated` : 'Up to date');
  if (changed && S.tab === 'podcasts' && !S.stacks.podcasts.length) rerenderKeepScroll();
}

async function downloadEpisode(p) {
  if (S.downloading.has(p.id)) return;
  S.downloading.add(p.id); refreshEpButtons();
  try {
    const blob = await fetchVia(p.url, 'blob');
    await DB.put('blobs', 'ep:' + p.id, blob);
    S.epDl[p.id] = Object.assign({}, p, { savedAt: Date.now(), size: blob.size });
    await saveKV.epDl();
    toast('Downloaded');
    requestPersist();
  } catch (e) {
    toast(e.message === 'relay-needed' ? 'This host blocks downloads. Set up the relay in Settings.' : "Download failed. Check your connection.", 3500);
  }
  S.downloading.delete(p.id); refreshEpButtons();
  if (Player.cur && Player.cur.id === p.id) updatePlayerUI();
}
async function removeDownload(id) {
  await DB.del('blobs', 'ep:' + id);
  delete S.epDl[id]; await saveKV.epDl();
  toast('Download removed');
}
function refreshEpButtons() { rerenderKeepScroll(); }

/* ----- Discover ----- */
const RADIO_HOSTS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://fi1.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];
async function radioFetch(path) {
  let err;
  for (const h of shuffleArr(RADIO_HOSTS)) { try { return await getJSON(h + path); } catch (e) { err = e; } }
  throw err;
}
const DISC_TABS = [['archive', 'Free music'], ['jamendo', 'Indie artists'], ['radio', 'Radio']];
const DISC_SUGGEST = {
  archive: ['Carnatic', 'Hindustani', 'Indian classical', 'Live concerts', 'Jazz', 'Lo-fi', 'Ambient', 'Classical piano'],
  jamendo: ['Chill', 'Lounge', 'Pop', 'Rock', 'Hip hop', 'Electronic', 'Acoustic', 'Indian', 'Piano', 'Workout'],
  radio: ['Tamil', 'Kannada', 'Hindi', 'Telugu', 'Malayalam', 'English', 'Carnatic', 'News'],
};
Views.discover = () => {
  const t = S.discTab;
  const chips = DISC_TABS.map(([k, l]) => `<button class="chip ${t === k ? 'on' : ''}" data-a="disctab" data-t="${k}">${l}</button>`).join('');
  let h = topbar('Discover') + `<div class="chips">${chips}</div>`;
  if (t === 'jamendo' && !S.settings.jamendo) {
    return h + `<div class="notice"><b>Indie artists</b> streams 600,000+ free songs from Jamendo. It needs a free key, one time:<br><br>
      1. Go to <b>developer.jamendo.com</b> and sign up<br>2. Create an app (any name)<br>3. Copy the <b>Client ID</b> into Settings</div>
      <button class="btn primary" data-a="go" data-v="settings">Open settings</button>`;
  }
  const ph = t === 'radio' ? 'Station name or genre' : t === 'archive' ? 'Search free recordings' : 'Song, artist, or mood';
  const cur = S.disc[t] || {};
  h += `<form data-f="disc"><div class="search">${icon('search')}<input id="dq" type="search" placeholder="${ph}" value="${esc(cur.q || '')}" autocomplete="off" enterkeyhint="search"></div></form>`;
  h += `<div class="chips">${DISC_SUGGEST[t].map(s => `<button class="chip ${cur.q === s ? 'on' : ''}" data-a="discq" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
  if (t === 'archive') h += `<p class="dim" style="font-size:12px;margin:-4px 0 10px">Only Creative Commons, public domain, and live-taping friendly recordings from the Internet Archive.</p>`;
  h += `<div id="dresults"></div>`;
  return h;
};
Views.discover.after = () => {
  const t = S.discTab;
  if (t === 'jamendo' && !S.settings.jamendo) return;
  const cur = S.disc[t];
  if (cur && cur.html) { $('#dresults').innerHTML = cur.html; restoreDiscLists(cur); hydrateArt($('#dresults')); markPlayingRows(); return; }
  runDiscover(cur ? cur.q : (t === 'radio' ? 'Tamil' : ''));
};
function restoreDiscLists(cur) { if (cur.lists) Object.assign(S.lists, cur.lists); }
async function runDiscover(q) {
  const t = S.discTab;
  const box = $('#dresults'); if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  let html;
  const before = new Set(Object.keys(S.lists));
  try {
    if (t === 'radio') html = await discRadio(q);
    else if (t === 'jamendo') html = await discJamendo(q);
    else html = await discArchive(q);
  } catch (e) {
    console.error(e);
    html = emptyHTML('compass', "Couldn't load right now", t === 'jamendo' ? 'Check your Jamendo key in Settings and your connection.' : 'Check your internet connection and try again.');
  }
  if (S.discTab !== t || !$('#dresults')) return;
  const lists = {}; for (const k of Object.keys(S.lists)) if (!before.has(k)) lists[k] = S.lists[k];
  S.disc[t] = { q, html, lists };
  box.innerHTML = html; hydrateArt(box); markPlayingRows();
  document.querySelectorAll('[data-a="discq"]').forEach(c => c.classList.toggle('on', c.dataset.q === q));
}
async function discRadio(q) {
  const langs = ['tamil', 'kannada', 'hindi', 'telugu', 'malayalam', 'english'];
  const ql = (q || '').toLowerCase();
  const base = '&hidebroken=true&order=clickcount&reverse=true&limit=80';
  const path = langs.includes(ql) ? `/json/stations/search?language=${encodeURIComponent(ql)}${base}`
    : q ? `/json/stations/search?name=${encodeURIComponent(q)}${base}` : `/json/stations/search?countrycode=IN${base}`;
  let st = await radioFetch(path);
  if (q && !langs.includes(ql) && st.length < 5) st = st.concat(await radioFetch(`/json/stations/search?tag=${encodeURIComponent(ql)}${base}`));
  const seen = new Set();
  const items = st.filter(s => s.url_resolved && s.url_resolved.startsWith('https://') && !seen.has(s.stationuuid) && seen.add(s.stationuuid)).slice(0, 60).map(radioP);
  if (!items.length) return emptyHTML('radio', 'No stations found', 'Try a language or a different name.');
  return `<div class="section-title">${items.length} stations</div>` + rowsHTML(items, q ? q + ' radio' : 'Radio');
}
async function discJamendo(q) {
  const key = encodeURIComponent(S.settings.jamendo.trim());
  const tagish = DISC_SUGGEST.jamendo.includes(q);
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${key}&format=json&limit=50&audioformat=mp32&imagesize=300&order=popularity_total` +
    (q ? (tagish ? '&fuzzytags=' + encodeURIComponent(q.toLowerCase()) : '&search=' + encodeURIComponent(q)) : '&boost=popularity_month');
  const data = await getJSON(url);
  if (data.headers && data.headers.status === 'failed') throw new Error(data.headers.error_message || 'Jamendo error');
  const items = (data.results || []).filter(t => t.audio).map(jamP);
  if (!items.length) return emptyHTML('compass', 'Nothing found', 'Try another word or mood.');
  return `<div class="section-title">${q ? 'Results' : 'Popular this month'}</div>` + rowsHTML(items, q || 'Jamendo', { dur: true });
}
const IA_FILTER = '(collection:netlabels OR collection:etree OR (collection:audio_music AND (licenseurl:*creativecommons* OR licenseurl:*publicdomain*)))';
async function discArchive(q) {
  const query = `${q ? '(' + q + ') AND ' : ''}mediatype:audio AND ${IA_FILTER}`;
  const url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(query) +
    '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&rows=40&page=1&output=json&sort[]=downloads+desc';
  const data = await getJSON(url);
  const docs = (data.response && data.response.docs) || [];
  if (!docs.length) return emptyHTML('compass', 'Nothing found', 'Try a broader word, like a genre or instrument.');
  return `<div class="section-title">${q ? 'Results' : 'Most played'}</div>` + docs.map(d => {
    const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
    const title = Array.isArray(d.title) ? d.title[0] : d.title;
    return `<button class="row" data-a="go" data-v="iaitem" data-p="${esc(d.identifier)}">${artHTML({ title, artUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}` }, '', 46)}
      <div class="meta"><div class="t ellipsis">${esc(title || d.identifier)}</div><div class="s ellipsis">${esc(creator || 'Unknown')}${d.year ? ' · ' + esc(d.year) : ''}</div></div></button>`;
  }).join('');
}
Views.iaitem = async id => {
  const meta = await getJSON('https://archive.org/metadata/' + encodeURIComponent(id));
  const md = meta.metadata || {};
  const title = [].concat(md.title || id)[0];
  const creator = [].concat(md.creator || 'Unknown')[0];
  const art = `https://archive.org/services/img/${encodeURIComponent(id)}`;
  const files = (meta.files || []).filter(f => /\.mp3$/i.test(f.name) && f.source !== 'metadata');
  const prefer = files.filter(f => /VBR MP3/i.test(f.format));
  const list = (prefer.length ? prefer : files).sort((a, b) => (parseInt(a.track) || 0) - (parseInt(b.track) || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const path = n => n.split('/').map(encodeURIComponent).join('/');
  const items = list.map(f => ({
    type: 'remote', source: 'archive', key: 'ia:' + id + '/' + f.name, id: id + '/' + f.name,
    title: f.title || f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]+/, ''), sub: f.creator || f.artist || creator, artist: f.creator || creator, album: title,
    url: `https://archive.org/download/${encodeURIComponent(id)}/${path(f.name)}`, dl: null, artUrl: art, duration: parseDur(f.length),
  }));
  items.forEach(i => { i.dl = i.url; });
  const L = reg(items, title);
  let h = topbar('', { back: true }) + heroHTML({ title, artUrl: art }, title, creator);
  const lic = md.licenseurl ? `<p class="dim" style="font-size:12px;text-align:center">License: ${esc(String(md.licenseurl).replace(/^https?:\/\//, ''))}</p>` : '';
  h += lic;
  if (!items.length) return h + emptyHTML('music', 'No playable tracks', 'This item has no MP3 files.');
  return h + playBar(L) + rowsHTML(items, title, { dur: true });
};

async function saveRemote(p) {
  if (S.tracks.some(t => t.remoteKey === p.key)) { toast('Already in your library'); return; }
  toast('Saving to library…', 0);
  try {
    const blob = await fetchVia(p.dl || p.url, 'blob');
    const id = 't' + uid();
    let hasArt = false;
    if (p.artUrl) { try { const a = await fetchVia(p.artUrl, 'blob'); if (a.size && /^image\//.test(a.type)) { await DB.put('art', id, a); hasArt = true; } } catch { } }
    await DB.put('blobs', id, blob);
    const t = { id, title: p.title, artist: p.artist || p.sub || 'Unknown artist', album: p.album || 'Saved', duration: p.duration || 0, addedAt: Date.now(), hasArt, source: p.source, remoteKey: p.key, fileKey: 'remote|' + p.key };
    await DB.put('tracks', id, t);
    S.tracks.push(t);
    toast('Saved to your library');
    requestPersist();
  } catch (e) {
    toast(e.message === 'relay-needed' ? 'This source blocks saving. Set up the relay in Settings.' : "Couldn't save. Check your connection.", 3500);
  }
}

/* ----- Settings ----- */
Views.settings = async () => {
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1048576).toFixed(0)} MB used`; } catch { }
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  return topbar('Settings', { back: true }) + `
    <form data-f="settings">
      <div class="field"><label for="s-jam">Jamendo Client ID (for Indie artists)</label><input id="s-jam" value="${esc(S.settings.jamendo)}" placeholder="a1b2c3d4" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="s-relay">Podcast relay URL (optional)</label><input id="s-relay" value="${esc(S.settings.relay)}" placeholder="https://isai-relay.yourname.workers.dev" autocomplete="off" spellcheck="false" inputmode="url"></div>
      <button class="btn primary" type="submit">Save</button>
    </form>
    <div class="section-title">Storage</div>
    <div class="setting-row"><span>Songs</span><span class="muted">${S.tracks.length}</span></div>
    <div class="setting-row"><span>Downloaded episodes</span><span class="muted">${Object.keys(S.epDl).length}</span></div>
    <div class="setting-row"><span>Space used</span><span class="muted">${esc(est || 'Unknown')}</span></div>
    <div class="setting-row"><span>Protected from cleanup</span><span class="${persisted ? 'acc' : 'muted'}">${persisted ? 'Yes' : 'Not yet'}</span></div>
    ${persisted ? '' : `<p class="muted" style="font-size:13px">Install Isai to your home screen so Android keeps your songs safe. Keep the originals in your Rajan folder as a backup either way.</p>`}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn small ghost" data-a="clear-dl">${icon('trash', 'sm')} Delete all downloads</button>
      <button class="btn small ghost" data-a="clear-recent">Clear recently played</button>
    </div>
    <div class="section-title">About</div>
    <p class="muted" style="font-size:13px">Isai ${VERSION}. No ads, no tracking, no account. Your songs, playlists, and podcasts are stored only on this phone.</p>`;
};

/* ---------- import ---------- */
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|mp4)$/i;
function readTags(file) {
  return new Promise(res => {
    const done = v => { clearTimeout(t); res(v); };
    const t = setTimeout(() => res({}), 8000);
    try { window.jsmediatags.read(file, { onSuccess: r => done(r.tags || {}), onError: () => done({}) }); } catch { done({}); }
  });
}
function readDuration(file) {
  return new Promise(res => {
    const a = new Audio(); const u = URL.createObjectURL(file);
    const fin = v => { clearTimeout(t); URL.revokeObjectURL(u); a.src = ''; res(v); };
    const t = setTimeout(() => fin(0), 6000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => fin(0);
    a.src = u;
  });
}
async function importFiles(fileList) {
  const files = [...fileList].filter(f => AUDIO_RE.test(f.name) || /^audio\//.test(f.type));
  if (!files.length) { toast('No audio files selected'); return; }
  const have = new Set(S.tracks.map(t => t.fileKey));
  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(`Adding songs ${i + 1} of ${files.length}`, 0);
    const fileKey = f.name + '|' + f.size;
    if (have.has(fileKey)) { skipped++; continue; }
    try {
      const tags = await readTags(f);
      const duration = await readDuration(f);
      const id = 't' + uid();
      let hasArt = false;
      if (tags.picture && tags.picture.data && tags.picture.data.length) {
        await DB.put('art', id, new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format || 'image/jpeg' }));
        hasArt = true;
      }
      const clean = s => (s == null ? '' : String(s)).replace(/\0/g, '').trim();
      const base = f.name.replace(/\.[^.]+$/, '');
      let title = clean(tags.title), artist = clean(tags.artist);
      if (!title) {
        const m = base.match(/^(?:\d+[\s._-]+)?(.+?)\s+-\s+(.+)$/);
        if (m && !artist) { artist = m[1]; title = m[2]; } else title = base.replace(/^\d+[\s._-]+/, '');
      }
      const t = {
        id, title, artist: artist || 'Unknown artist', album: clean(tags.album) || 'Unknown album',
        year: clean(tags.year), track: parseInt(tags.track) || 0, duration, addedAt: Date.now() + i,
        hasArt, source: 'file', fileKey,
      };
      await DB.put('blobs', id, f);
      await DB.put('tracks', id, t);
      S.tracks.push(t); have.add(fileKey); added++;
    } catch (e) { console.error(e); failed++; }
    if (i % 10 === 9) await sleep(0);
  }
  toast(`Added ${added} song${added === 1 ? '' : 's'}` + (skipped ? `, ${skipped} already there` : '') + (failed ? `, ${failed} failed` : ''), 3500);
  if (added) requestPersist();
  rerenderKeepScroll();
}
function requestPersist() { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { }); }

/* ---------- sheets ---------- */
function sheetHead(p) {
  return `<div class="sheet-head">${artHTML(p, '', 48)}<div class="meta" style="min-width:0"><div class="t ellipsis" style="font-weight:600">${esc(p.title)}</div><div class="s ellipsis muted" style="font-size:13px">${esc(p.sub || '')}</div></div></div>`;
}
const opt = (a, ic, label, data = '', cls = '') => `<button class="opt ${cls}" data-a="${a}" ${data}>${icon(ic)}${esc(label)}</button>`;
let sheetItem = null;
function itemSheet(p, plId) {
  sheetItem = p;
  let h = sheetHead(p);
  if (p.type !== 'radio') { h += opt('s-next', 'next-q', 'Play next') + opt('s-queue', 'list', 'Add to queue'); }
  if (p.type === 'song') {
    const t = trackById(p.id);
    h += opt('s-addpl', 'plus', 'Add to playlist');
    h += opt('s-like', S.liked.has(p.id) ? 'heart-f' : 'heart', S.liked.has(p.id) ? 'Remove from liked songs' : 'Add to liked songs');
    if (t) { h += opt('s-album', 'album', 'Go to album') + opt('s-artist', 'user', 'Go to artist'); }
    if (plId && plId !== 'liked') h += opt('s-unpl', 'x', 'Remove from this playlist', `data-p="${esc(plId)}"`);
    h += opt('s-delete', 'trash', 'Remove from library', '', 'danger');
  } else if (p.type === 'remote') {
    h += opt('s-save', 'download', S.tracks.some(t => t.remoteKey === p.key) ? 'Saved in library' : 'Save to library');
  } else if (p.type === 'episode') {
    h += S.epDl[p.id] ? opt('s-undl', 'trash', 'Remove download') : opt('s-dl', 'download', 'Download');
    const done = S.progress[p.id] && S.progress[p.id].done;
    h += opt('s-played', 'check', done ? 'Mark as unplayed' : 'Mark as played');
    if (p.desc) h += opt('s-notes', 'notes', 'Episode notes');
    h += opt('s-show', 'mic', 'Go to show');
  } else if (p.type === 'radio') {
    const fav = S.radioFavs.some(s => s.key === p.key);
    h += opt('s-fav', fav ? 'star-f' : 'star', fav ? 'Remove from your stations' : 'Add to your stations');
  }
  openSheet(h);
}
function playlistPicker(p) {
  sheetItem = p;
  openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:6px">Add to playlist</div>` + opt('pl-new-add', 'plus', 'New playlist') +
    S.playlists.map(pl => `<button class="opt" data-a="pl-add" data-p="${esc(pl.id)}">${artHTML(plCover(pl), '', 40).replace('class="art ', 'style="width:40px;height:40px" class="art ')}<span>${esc(pl.name)} <span class="muted" style="font-size:13px">· ${pl.ids.length}</span></span></button>`).join(''));
}
function queueSheet() {
  const q = Player.queue, i = Player.idx;
  if (!q.length) { openSheet(emptyHTML('list', 'Queue is empty', 'Play something to start a queue.')); return; }
  const row = (p, j) => `<div class="qrow ${j === i ? 'now' : ''}"><button style="display:flex;gap:10px;align-items:center;flex:1;min-width:0;text-align:left" data-a="q-jump" data-i="${j}">${artHTML(p, '', 40).replace('class="art ', 'style="width:40px;height:40px" class="art ')}<div class="meta"><div class="t ellipsis">${esc(p.title)}</div><div class="s ellipsis">${esc(p.sub || '')}</div></div></button>${j !== i ? `<button class="iconbtn" data-a="q-remove" data-i="${j}" aria-label="Remove">${icon('x', 'sm')}</button>` : ''}</div>`;
  let h = `<div style="font-weight:700;font-size:17px;margin-bottom:8px">Now playing</div>${row(q[i], i)}`;
  const next = q.slice(i + 1);
  if (next.length) h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 6px"><span style="font-weight:700;font-size:17px">Next up</span><button class="btn small ghost" data-a="q-clear">Clear</button></div>` + next.map((p, k) => row(p, i + 1 + k)).join('');
  else h += `<p class="muted" style="font-size:13px;margin-top:16px">Nothing queued after this.</p>`;
  openSheet(h);
}
function sleepSheet() {
  const cur = Player.sleepAt || Player.sleepEnd;
  openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:6px">Sleep timer</div>` +
    [5, 15, 30, 45, 60].map(m => `<button class="opt" data-a="sleep" data-m="${m}">${icon('moon')}${m} minutes</button>`).join('') +
    `<button class="opt" data-a="sleep" data-m="end">${icon('moon')}End of this ${Player.cur?.type === 'episode' ? 'episode' : 'track'}</button>` +
    (cur ? `<button class="opt danger" data-a="sleep" data-m="off">${icon('x')}Turn off timer</button>` : ''));
}

/* ---------- playlist ops ---------- */
async function newPlaylist(firstId) {
  const name = (prompt('Playlist name') || '').trim();
  if (!name) return null;
  const pl = { id: 'p' + uid(), name, ids: firstId ? [firstId] : [], createdAt: Date.now() };
  S.playlists.unshift(pl); await saveKV.playlists();
  return pl;
}
async function deleteTrack(id) {
  await DB.del('blobs', id); await DB.del('art', id); await DB.del('tracks', id);
  S.tracks = S.tracks.filter(t => t.id !== id);
  S.liked.delete(id); await saveKV.liked();
  S.playlists.forEach(pl => pl.ids = pl.ids.filter(x => x !== id)); await saveKV.playlists();
  S.recent = S.recent.filter(p => p.key !== 'song:' + id); await saveKV.recent();
  const ci = Player.queue.findIndex(p => p.key === 'song:' + id);
  if (ci >= 0 && ci !== Player.idx) { Player.queue.splice(ci, 1); if (ci < Player.idx) Player.idx--; }
}

/* ---------- events ---------- */
const listItem = d => { const l = S.lists[d.l]; return l ? l.items[+d.i] : null; };
const A = {
  back: () => closeTop(),
  tab: d => setTab(d.t),
  go: d => go(d.v, d.p ?? {}),
  import: () => $('#file-input').click(),
  play: d => {
    const l = S.lists[d.l]; if (!l) return;
    const p = l.items[+d.i];
    if (Player.cur && p && Player.cur.key === p.key && Player.ready) { Player.toggle(); return; }
    Player.play(l.items, +d.i, l.ctx);
  },
  'play-one': d => { const p = listItem(d); if (p) Player.play([p], 0, 'Recently played'); },
  'shuffle-list': d => { const l = S.lists[d.l]; if (!l || !l.items.length) return; Player.shuffle = true; Player.play(l.items, Math.floor(Math.random() * l.items.length), l.ctx); },
  'shuffle-all': () => { const items = S.tracks.map(songP); if (!items.length) return; Player.shuffle = true; Player.play(items, Math.floor(Math.random() * items.length), 'Your library'); },
  more: (d, el) => { const p = listItem(d); if (p) itemSheet(p, el.dataset.pl); },
  'fav-radio': d => { const p = listItem(d); if (p) toggleFav(p); },
  'dl-ep': d => { const p = listItem(d); if (!p) return; if (S.epDl[p.id]) itemSheet(p); else downloadEpisode(p); },
  libtab: d => { S.libTab = d.t; render(); },
  podtab: d => { S.podTab = d.t; render(); },
  disctab: d => { S.discTab = d.t; render(); },
  discq: d => { const i = $('#dq'); if (i) i.value = d.q; runDiscover(d.q); },
  podq: d => { const i = $('#pq'); if (i) i.value = d.q; runPodSearch(d.q); },
  'pod-open': d => {
    const r = S.podResults[+d.i]; if (!r) return;
    const id = hash(r.feedUrl);
    if (!S.podcasts.some(p => p.id === id)) S.feedCache[id] = { id, feedUrl: r.feedUrl, itunesId: r.collectionId, title: r.collectionName, author: r.artistName, art: r.artworkUrl600 || r.artworkUrl100, episodes: [] };
    go('show', id);
  },
  sub: async d => {
    const pod = S.feedCache[d.p]; if (!pod) return;
    if (!pod.episodes.length) { try { Object.assign(pod, await loadFeed(pod.feedUrl, pod.itunesId)); } catch { toast("Couldn't load this show"); return; } }
    pod.fetchedAt = Date.now();
    S.podcasts.push(pod); await saveKV.podcasts(); toast('Following ' + pod.title); rerenderKeepScroll();
  },
  unsub: async d => {
    if (!confirm('Unfollow this show? Downloaded episodes stay in Downloads.')) return;
    const pod = S.podcasts.find(p => p.id === d.p);
    S.podcasts = S.podcasts.filter(p => p.id !== d.p); if (pod) S.feedCache[pod.id] = pod;
    await saveKV.podcasts(); rerenderKeepScroll();
  },
  'refresh-pods': () => refreshPodcasts(true),
  'new-playlist': async () => { const pl = await newPlaylist(); if (pl) go('playlist', pl.id); },
  'pl-more': d => {
    const pl = S.playlists.find(p => p.id === d.p); if (!pl) return;
    openSheet(`<div class="sheet-head">${artHTML(plCover(pl), '', 48)}<div style="font-weight:600">${esc(pl.name)}</div></div>` + opt('pl-rename', 'edit', 'Rename', `data-p="${esc(pl.id)}"`) + opt('pl-delete', 'trash', 'Delete playlist', `data-p="${esc(pl.id)}"`, 'danger'));
  },
  'pl-rename': async d => { const pl = S.playlists.find(p => p.id === d.p); const n = (prompt('Rename playlist', pl.name) || '').trim(); if (n) { pl.name = n; await saveKV.playlists(); } closeSheet(); setTimeout(rerenderKeepScroll, 60); },
  'pl-delete': async d => { if (!confirm('Delete this playlist? Songs stay in your library.')) return; S.playlists = S.playlists.filter(p => p.id !== d.p); await saveKV.playlists(); closeSheet(); setTimeout(() => closeTop(), 80); },
  's-next': () => { Player.addNext(sheetItem); closeSheet(); },
  's-queue': () => { Player.addQueue(sheetItem); closeSheet(); },
  's-addpl': () => playlistPicker(sheetItem),
  'pl-add': async d => {
    const pl = S.playlists.find(p => p.id === d.p);
    if (pl.ids.includes(sheetItem.id)) toast('Already in ' + pl.name);
    else { pl.ids.push(sheetItem.id); await saveKV.playlists(); toast('Added to ' + pl.name); }
    closeSheet();
  },
  'pl-new-add': async () => { const pl = await newPlaylist(sheetItem.id); if (pl) toast('Added to ' + pl.name); closeSheet(); },
  's-like': async () => { await toggleLike(sheetItem.id); closeSheet(); },
  's-album': () => { const a = sheetItem.album; closeSheet(); setTimeout(() => go('album', a), 60); },
  's-artist': () => { const a = sheetItem.artist; closeSheet(); setTimeout(() => go('artist', a), 60); },
  's-unpl': async d => { const pl = S.playlists.find(p => p.id === d.p); pl.ids = pl.ids.filter(x => x !== sheetItem.id); await saveKV.playlists(); closeSheet(); setTimeout(rerenderKeepScroll, 60); },
  's-delete': async () => {
    if (!confirm(`Remove "${sheetItem.title}" from Isai? The original file in your Rajan folder isn't touched.`)) return;
    await deleteTrack(sheetItem.id); toast('Removed'); closeSheet(); setTimeout(rerenderKeepScroll, 60);
  },
  's-save': () => { closeSheet(); saveRemote(sheetItem); },
  's-dl': () => { closeSheet(); downloadEpisode(sheetItem); },
  's-undl': async () => { await removeDownload(sheetItem.id); closeSheet(); setTimeout(rerenderKeepScroll, 60); },
  's-played': async () => {
    const pr = S.progress[sheetItem.id];
    S.progress[sheetItem.id] = pr && pr.done ? { t: 0, d: 0, done: false, at: Date.now() } : { t: 0, d: sheetItem.duration, done: true, at: Date.now() };
    await saveKV.progress(); closeSheet(); setTimeout(rerenderKeepScroll, 60);
  },
  's-notes': () => openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:4px">${esc(sheetItem.title)}</div><div class="muted" style="font-size:13px;margin-bottom:12px">${esc(sheetItem.sub)} · ${esc(relDate(sheetItem.pubDate))}</div><div style="white-space:pre-wrap;font-size:14px;line-height:1.55">${esc(sheetItem.desc)}</div>`),
  's-show': () => { const id = sheetItem.podId; closeSheet(); if (!S.podcasts.some(p => p.id === id) && !S.feedCache[id]) { toast('Show not followed'); return; } setTimeout(() => go('show', id), 60); },
  's-fav': () => { toggleFav(sheetItem); closeSheet(); },
  'q-jump': d => { Player.idx = +d.i; Player.load(true); closeSheet(); },
  'q-remove': d => { const j = +d.i; Player.queue.splice(j, 1); if (j < Player.idx) Player.idx--; saveState(); queueSheet(); },
  'q-clear': () => { Player.queue = Player.queue.slice(0, Player.idx + 1); Player.original = null; saveState(); queueSheet(); },
  sleep: d => {
    Player.sleepAt = 0; Player.sleepEnd = false;
    if (d.m === 'end') { Player.sleepEnd = true; toast('Stopping after this one'); }
    else if (d.m !== 'off') { Player.sleepAt = Date.now() + d.m * 60000; toast(`Sleep timer: ${d.m} minutes`); }
    else toast('Sleep timer off');
    updateSleepLabel(); closeSheet();
  },
  toggle: () => Player.toggle(),
  next: () => Player.next(),
  prev: () => Player.prev(),
  skip: d => Player.skip(+d.s),
  shuffle: () => { Player.setShuffle(!Player.shuffle); updatePlayerUI(); toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off', 1200); },
  repeat: () => { Player.repeat = { off: 'all', all: 'one', one: 'off' }[Player.repeat]; updatePlayerUI(); saveState(); toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat this song' }[Player.repeat], 1200); },
  speed: () => {
    const steps = [1, 1.25, 1.5, 1.75, 2, 0.8];
    Player.speed = steps[(steps.indexOf(Player.speed) + 1) % steps.length];
    audio.playbackRate = Player.speed; audio.defaultPlaybackRate = Player.speed; updatePlayerUI(); saveState();
  },
  'clear-dl': async () => {
    if (!confirm('Delete all downloaded episodes from this phone?')) return;
    for (const id of Object.keys(S.epDl)) await DB.del('blobs', 'ep:' + id);
    S.epDl = {}; await saveKV.epDl(); toast('Downloads deleted'); rerenderKeepScroll();
  },
  'clear-recent': async () => { S.recent = []; await saveKV.recent(); toast('Cleared'); },
  'switch-profile': () => switchProfile(),
  together: () => togetherSheet(),
  'tg-host': () => Together.host(),
  'tg-leave': () => { Together.leave(); closeSheet(); },
  'tg-heart': () => Together.react(),
  'tg-share': async () => {
    const text = `Join me on Isai. Open Listen together and enter code ${Together.code}`;
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch { return; }
    try { await navigator.clipboard.writeText(Together.code); toast('Code copied'); } catch { toast('Code: ' + Together.code, 4000); }
  },
  'pf-rename': () => {
    const p = editingProfile; if (!p) return;
    const n = (prompt('Profile name', p.name) || '').trim().slice(0, 20);
    if (!n) return;
    p.name = n; touchProfile(p); if (saveProfiles()) afterProfileEdit('Name updated');
  },
  'pf-avatar': () => avatarSheet(),
  'pf-set-av': d => { const p = editingProfile; if (!p) return; p.avatar = d.k; delete p.photo; touchProfile(p); if (saveProfiles()) afterProfileEdit('Avatar updated'); },
  'pf-photo': () => $('#photo-input').click(),
  'pf-clear': async () => {
    const p = editingProfile; if (!p) return;
    if (!confirm(`Delete all of ${p.name}'s songs, playlists, likes, podcasts, and history on this phone? This can't be undone.`)) return;
    const isMe = ME && ME.id === p.id;
    if (isMe) { try { audio.pause(); } catch { } try { DB.db && DB.db.close(); } catch { } }
    await new Promise(res => { const r = indexedDB.deleteDatabase(dbNameFor(p.id)); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    if (isMe) { try { sessionStorage.removeItem('isai-profile'); } catch { } location.reload(); return; }
    afterProfileEdit(`${p.name}'s data cleared`);
  },
};
async function toggleLike(id) {
  if (S.liked.has(id)) { S.liked.delete(id); toast('Removed from liked songs', 1400); } else { S.liked.add(id); toast('Added to liked songs', 1400); }
  await saveKV.liked();
  updatePlayerUI(); rerenderKeepScroll();
}
async function toggleFav(p) {
  const on = S.radioFavs.some(s => s.key === p.key);
  S.radioFavs = on ? S.radioFavs.filter(s => s.key !== p.key) : [p, ...S.radioFavs];
  await saveKV.radioFavs();
  toast(on ? 'Removed from your stations' : 'Added to your stations', 1400);
  updatePlayerUI();
  if (S.disc.radio) S.disc.radio.html = null;
  rerenderKeepScroll();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); e.stopPropagation(); fn(el.dataset, el); }
});
document.addEventListener('submit', async e => {
  const f = e.target.dataset.f; if (!f) return;
  e.preventDefault();
  if (f === 'tg-join') { const v = $('#tg-code').value; $('#tg-code').blur(); Together.join(v); return; }
  if (f === 'disc') { const q = $('#dq').value.trim(); $('#dq').blur(); runDiscover(q); }
  if (f === 'podsearch') { const q = $('#pq').value.trim(); $('#pq').blur(); if (q) runPodSearch(q); }
  if (f === 'settings') {
    S.settings.jamendo = $('#s-jam').value.trim();
    S.settings.relay = $('#s-relay').value.trim();
    await saveKV.settings(); delete S.disc.jamendo; toast('Settings saved');
  }
});
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#file-input').addEventListener('change', e => { const f = e.target.files; if (f && f.length) importFiles(f); e.target.value = ''; });
$('#mini').addEventListener('click', e => { if (!e.target.closest('button')) openNP(); });
$('#mini-play').addEventListener('click', e => { e.stopPropagation(); Player.toggle(); });
const likeAction = async () => {
  const p = Player.cur; if (!p) return;
  if (p.type === 'song') await toggleLike(p.id);
  else if (p.type === 'radio') toggleFav(p);
  else if (p.type === 'remote') saveRemote(p);
  else if (p.type === 'episode') { if (S.epDl[p.id]) itemSheet(p); else downloadEpisode(p); }
};
$('#mini-like').addEventListener('click', e => { e.stopPropagation(); likeAction(); });
$('#np-like').addEventListener('click', likeAction);
$('#np-close').addEventListener('click', () => closeTop());
$('#np-more').addEventListener('click', () => { if (Player.cur) itemSheet(Player.cur); });
$('#np-queue').addEventListener('click', queueSheet);
$('#np-together').addEventListener('click', togetherSheet);
$('#np-sleep').addEventListener('click', sleepSheet);
$('#np-add').addEventListener('click', () => {
  const p = Player.cur; if (!p) return;
  if (p.type === 'song') playlistPicker(p);
  else if (p.type === 'remote') saveRemote(p);
  else itemSheet(p);
});
$('#scrim').addEventListener('click', closeSheet);
const seek = $('#np-seek');
seek.addEventListener('input', () => {
  seeking = true;
  const pct = seek.value / 10; seek.style.setProperty('--p', pct + '%');
  if (isFinite(audio.duration)) $('#np-cur').textContent = fmt(audio.duration * pct / 100);
});
seek.addEventListener('change', () => {
  if (isFinite(audio.duration)) audio.currentTime = audio.duration * (seek.value / 1000);
  seeking = false;
});
// swipe down to close the player
let ty = null;
$('#np').addEventListener('touchstart', e => { if (!e.target.closest('input,button')) ty = e.touches[0].clientY; }, { passive: true });
$('#np').addEventListener('touchend', e => { if (ty != null && e.changedTouches[0].clientY - ty > 90) closeTop(); ty = null; });
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); Player.toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) Player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) Player.prev();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });

/* ---------- profiles ---------- */
const DEFAULT_PROFILES = [{ id: 'captain', name: 'Captain', avatar: 'captain' }, { id: 'donna', name: 'Donna', avatar: 'donna' }];
const dbNameFor = id => (id === 'captain' ? 'isai' : 'isai-' + id);
function loadProfiles() {
  try {
    const p = JSON.parse(localStorage.getItem('isai-profiles') || 'null');
    if (Array.isArray(p) && p.length === 2 && p.every(x => x && x.id && x.name)) return p;
  } catch { }
  return DEFAULT_PROFILES.map(x => ({ ...x }));
}
let PROFILES = loadProfiles();
let ME = null;
function touchProfile(p) { p.updatedAt = Date.now(); }
function saveProfiles() { try { localStorage.setItem('isai-profiles', JSON.stringify(PROFILES)); return true; } catch { toast("Couldn't save that change. The photo may be too large."); return false; } }
const person = (bg, shirt, skin, hair, extra = '') => `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/><path d="M22 100 C22 76 34 66 50 66 C66 66 78 76 78 100 Z" fill="${shirt}"/>${extra.includes('@collar') ? '' : ''}<circle cx="50" cy="44" r="17" fill="${skin}"/>${hair}${extra.replace('@collar', '')}</svg>`;
const AVATARS = {
  captain: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#1c2b3a"/><path d="M22 100 C22 76 34 66 50 66 C66 66 78 76 78 100 Z" fill="#26364a"/><path d="M42 66 L50 80 L58 66 Z" fill="#f2f2f2"/><path d="M48 70 L50 92 L52 70 Z" fill="#EF9F27"/><circle cx="50" cy="44" r="17" fill="#c58a5c"/><path d="M33 42 C33 28 42 22 52 23 C62 24 68 31 67 42 C64 34 56 31 48 33 C42 34 36 37 33 42 Z" fill="#1f1a17"/></svg>`,
  donna: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#3a1f2a"/><path d="M22 100 C22 76 34 66 50 66 C66 66 78 76 78 100 Z" fill="#7a2e4a"/><circle cx="50" cy="44" r="17" fill="#d9a07a"/><path d="M31 50 C28 30 38 20 51 21 C64 22 72 32 69 50 C67 44 64 38 60 35 C54 38 44 38 38 34 C35 38 33 44 31 50 Z" fill="#1f1a17"/><g transform="translate(70 18)" fill="#f4efe6"><ellipse cx="0" cy="-5" rx="3" ry="5"/><ellipse cx="0" cy="-5" rx="3" ry="5" transform="rotate(72)"/><ellipse cx="0" cy="-5" rx="3" ry="5" transform="rotate(144)"/><ellipse cx="0" cy="-5" rx="3" ry="5" transform="rotate(216)"/><ellipse cx="0" cy="-5" rx="3" ry="5" transform="rotate(288)"/><circle r="2.5" fill="#EF9F27"/></g></svg>`,
  cap: person('#1c2b3a', '#378ADD', '#b77d52', '<path d="M32 38 C32 26 68 26 68 38 Z" fill="#EF9F27"/><path d="M60 37 H80" stroke="#EF9F27" stroke-width="5" stroke-linecap="round"/>'),
  bun: person('#2a1d2e', '#5DCAA5', '#c9926a', '<circle cx="50" cy="20" r="9" fill="#1f1a17"/><path d="M33 42 C33 28 67 28 67 42 C62 36 38 36 33 42 Z" fill="#1f1a17"/>'),
  listener: person('#1f1a12', '#AFA9EC', '#a8714a', '<path d="M33 44 C33 30 67 30 67 44" fill="none" stroke="#1f1a17" stroke-width="7"/><path d="M30 46 a20 20 0 0 1 40 0" fill="none" stroke="#EF9F27" stroke-width="4"/><rect x="27" y="42" width="8" height="12" rx="3" fill="#EF9F27"/><rect x="65" y="42" width="8" height="12" rx="3" fill="#EF9F27"/>'),
  glasses: person('#25202a', '#F0997B', '#d9a07a', '<path d="M32 46 C30 26 70 26 68 46 C64 34 36 34 32 46 Z" fill="#2c2420"/><circle cx="43" cy="46" r="5" fill="none" stroke="#2c2420" stroke-width="2"/><circle cx="57" cy="46" r="5" fill="none" stroke="#2c2420" stroke-width="2"/><path d="M48 46 h4" stroke="#2c2420" stroke-width="2"/>'),
  tiger: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a1d12"/><circle cx="30" cy="34" r="10" fill="#EF9F27"/><circle cx="70" cy="34" r="10" fill="#EF9F27"/><circle cx="50" cy="56" r="28" fill="#EF9F27"/><path d="M50 30 v10 M38 34 l4 8 M62 34 l-4 8 M24 54 h10 M66 54 h10" stroke="#2b1700" stroke-width="3" stroke-linecap="round"/><ellipse cx="50" cy="66" rx="12" ry="9" fill="#fbf6ee"/><circle cx="40" cy="52" r="3" fill="#2b1700"/><circle cx="60" cy="52" r="3" fill="#2b1700"/><path d="M47 62 h6 l-3 3 Z" fill="#2b1700"/></svg>`,
  elephant: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#1e2a33"/><circle cx="26" cy="46" r="17" fill="#8fa3b3"/><circle cx="74" cy="46" r="17" fill="#8fa3b3"/><circle cx="50" cy="48" r="22" fill="#a9bccb"/><path d="M50 58 C50 72 44 80 38 80" fill="none" stroke="#a9bccb" stroke-width="10" stroke-linecap="round"/><circle cx="42" cy="44" r="3" fill="#1e2a33"/><circle cx="58" cy="44" r="3" fill="#1e2a33"/></svg>`,
  peacock: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#0e2420"/><g fill="#5DCAA5"><ellipse cx="30" cy="40" rx="8" ry="16" transform="rotate(-30 30 40)"/><ellipse cx="50" cy="32" rx="8" ry="16"/><ellipse cx="70" cy="40" rx="8" ry="16" transform="rotate(30 70 40)"/></g><g fill="#185FA5"><circle cx="30" cy="34" r="4"/><circle cx="50" cy="24" r="4"/><circle cx="70" cy="34" r="4"/></g><ellipse cx="50" cy="66" rx="12" ry="18" fill="#378ADD"/><circle cx="50" cy="48" r="9" fill="#378ADD"/><circle cx="53" cy="46" r="2" fill="#fff"/><path d="M58 49 l7 2 -7 2 Z" fill="#EF9F27"/></svg>`,
  owl: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a2235"/><path d="M28 30 L36 42 M72 30 L64 42" stroke="#AFA9EC" stroke-width="5" stroke-linecap="round"/><ellipse cx="50" cy="58" rx="26" ry="28" fill="#AFA9EC"/><circle cx="40" cy="50" r="10" fill="#fbf6ee"/><circle cx="60" cy="50" r="10" fill="#fbf6ee"/><circle cx="40" cy="50" r="4" fill="#26215C"/><circle cx="60" cy="50" r="4" fill="#26215C"/><path d="M46 60 l4 6 4 -6 Z" fill="#EF9F27"/></svg>`,
  headphones: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#EF9F27"/><path d="M26 60 V50 a24 24 0 0 1 48 0 V60" fill="none" stroke="#2b1700" stroke-width="7" stroke-linecap="round"/><rect x="20" y="54" width="15" height="24" rx="6" fill="#2b1700"/><rect x="65" y="54" width="15" height="24" rx="6" fill="#2b1700"/></svg>`,
  vinyl: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#121212"/><circle cx="50" cy="50" r="32" fill="#2a2a2a"/><circle cx="50" cy="50" r="24" fill="none" stroke="#3a3a3a" stroke-width="1.5"/><circle cx="50" cy="50" r="12" fill="#ED93B1"/><circle cx="50" cy="50" r="2.5" fill="#121212"/></svg>`,
  jasmine: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#1d1a14"/><g transform="translate(50 50)"><g fill="#f4efe6"><ellipse cx="0" cy="-19" rx="9" ry="15"/><ellipse cx="0" cy="-19" rx="9" ry="15" transform="rotate(72)"/><ellipse cx="0" cy="-19" rx="9" ry="15" transform="rotate(144)"/><ellipse cx="0" cy="-19" rx="9" ry="15" transform="rotate(216)"/><ellipse cx="0" cy="-19" rx="9" ry="15" transform="rotate(288)"/></g><circle r="9" fill="#EF9F27"/></g></svg>`,
  wings: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#1c3550"/><g fill="#FAC775"><path d="M50 44 C40 40 26 40 12 44 C24 46 34 48 44 52 Z"/><path d="M50 44 C60 40 74 40 88 44 C76 46 66 48 56 52 Z"/><path d="M44 50 C36 50 26 52 18 54 C28 55 36 56 44 57 Z" opacity="0.8"/><path d="M56 50 C64 50 74 52 82 54 C72 55 64 56 56 57 Z" opacity="0.8"/></g><circle cx="50" cy="50" r="8" fill="#EF9F27"/><circle cx="50" cy="50" r="3.5" fill="#1c3550"/></svg>`,
};
function avatarHTML(p, size = 40) {
  const inner = p && p.photo ? `<img src="${esc(p.photo)}" alt="">` : (AVATARS[(p && p.avatar) || 'captain'] || AVATARS.captain);
  return `<span class="avatar" style="width:${size}px;height:${size}px">${inner}</span>`;
}
const LOGO_SVG = `<svg viewBox="0 0 100 100" width="48" height="48" aria-hidden="true"><rect width="100" height="100" rx="22" fill="#1e1e1e"/><path d="M18 50 Q26 30 34 50 T50 50 T66 50 T82 50" fill="none" stroke="#EF9F27" stroke-width="7" stroke-linecap="round"/><path d="M18 50 Q26 70 34 50" fill="none" stroke="#EF9F27" stroke-width="3" stroke-linecap="round" opacity="0.5"/></svg>`;

let pickerManage = false;
function showPicker(manage = false) {
  pickerManage = manage;
  const el = $('#picker');
  el.classList.remove('hidden');
  el.innerHTML = `<div class="pk-inner">${LOGO_SVG}<h1>${manage ? 'Manage profiles' : "Who's listening?"}</h1>
    <div class="pk-row">${PROFILES.map(p => `<button class="pk-item" data-pk="${esc(p.id)}" aria-label="${esc(p.name)}"><span class="pk-av">${avatarHTML(p, 112)}${manage ? `<span class="pk-edit">${icon('edit')}</span>` : ''}</span><span class="pk-name">${esc(p.name)}</span></button>`).join('')}</div>
    <button class="btn small ghost" data-pk-manage>${manage ? 'Done' : 'Manage profiles'}</button></div>`;
}
$('#picker').addEventListener('click', e => {
  const b = e.target.closest('[data-pk]');
  if (b) { if (pickerManage) profileSheet(b.dataset.pk); else chooseProfile(b.dataset.pk); return; }
  if (e.target.closest('[data-pk-manage]')) showPicker(!pickerManage);
});
function chooseProfile(id) {
  try { sessionStorage.setItem('isai-profile', id); } catch { }
  $('#picker').classList.add('hidden');
  start(id);
}
function switchProfile() {
  try { audio.pause(); saveState(); } catch { }
  Together.leave(true);
  try { sessionStorage.removeItem('isai-profile'); } catch { }
  location.reload();
}
let editingProfile = null;
function profileSheet(id) {
  const p = PROFILES.find(x => x.id === id); if (!p) return;
  editingProfile = p;
  openSheet(`<div class="sheet-head">${avatarHTML(p, 48)}<div style="font-weight:600;font-size:16px">${esc(p.name)}</div></div>` +
    opt('pf-rename', 'edit', 'Rename') + opt('pf-avatar', 'user', 'Change avatar') + opt('pf-clear', 'trash', `Clear ${p.name}'s data`, '', 'danger'));
}
function avatarSheet() {
  const p = editingProfile; if (!p) return;
  openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:12px">Choose an avatar</div>
    <div class="av-grid">${Object.keys(AVATARS).map(k => `<button class="av-opt ${!p.photo && p.avatar === k ? 'on' : ''}" data-a="pf-set-av" data-k="${k}" aria-label="${k}">${avatarHTML({ avatar: k }, 64)}</button>`).join('')}</div>
    <button class="btn ghost" style="width:100%;margin-top:16px" data-a="pf-photo">${icon('upload', 'sm')} Use a photo from this phone</button>`);
}
async function photoToDataURL(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas'); c.width = c.height = 240;
    const s = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 240, 240);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}
$('#photo-input').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f || !editingProfile) return;
  try {
    const old = editingProfile.photo;
    editingProfile.photo = await photoToDataURL(f); touchProfile(editingProfile);
    if (!saveProfiles()) { editingProfile.photo = old; return; }
    afterProfileEdit('Photo updated');
  } catch { toast("Couldn't use that photo"); }
});
function afterProfileEdit(msg) {
  Together.sendProfiles();
  closeSheet(); if (msg) toast(msg, 1600);
  setTimeout(() => {
    if (!$('#picker').classList.contains('hidden')) showPicker(pickerManage);
    if (ME) { ME = PROFILES.find(x => x.id === ME.id) || ME; rerenderKeepScroll(); }
  }, 80);
}

function mergeProfiles(incoming) {
  let changed = false;
  for (const inc of incoming) {
    if (!inc || typeof inc.id !== 'string' || typeof inc.name !== 'string') continue;
    const local = PROFILES.find(p => p.id === inc.id);
    if (!local) continue;
    if ((inc.updatedAt || 0) > (local.updatedAt || 0)) {
      local.name = inc.name.slice(0, 20);
      local.avatar = AVATARS[inc.avatar] ? inc.avatar : local.avatar;
      if (typeof inc.photo === 'string' && inc.photo.startsWith('data:image/') && inc.photo.length < 400000) local.photo = inc.photo; else delete local.photo;
      local.updatedAt = inc.updatedAt;
      changed = true;
    }
  }
  if (!changed) return;
  saveProfiles();
  if (ME) ME = PROFILES.find(p => p.id === ME.id) || ME;
  if (Together.partnerId) Together.partner = PROFILES.find(p => p.id === Together.partnerId) || Together.partner;
  if (!$('#picker').classList.contains('hidden')) showPicker(pickerManage);
  if (ME) rerenderKeepScroll();
  updateTogetherBar();
}

/* ---------- listen together ---------- */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const Together = {
  peer: null, conn: null, code: '', role: null, partner: null, offset: 0, controller: null,
  suppressUntil: 0, bt: null, hb: null, missing: null, status: 'idle', err: '',
  isSilent() { return (audio.currentSrc || audio.src || '').startsWith('data:audio/wav'); },
  connected() { return !!(this.conn && this.conn.open && this.partner); },
  makeCode() { const w = ['RAGA', 'TALA', 'VEENA', 'MALLI', 'KUYIL', 'ISAI', 'NILA', 'MAYIL', 'SWARA', 'PALLAVI']; return w[Math.floor(Math.random() * w.length)] + '-' + (10 + Math.floor(Math.random() * 90)); },
  peerId(code) { return 'isai-together-' + code.toLowerCase().replace(/[^a-z0-9]/g, ''); },
  unlock() {
    if (Player.ready && audio.src && !this.isSilent()) return;
    try { audio.src = SILENT_WAV; const p = audio.play(); if (p) p.then(() => audio.pause()).catch(() => { }); } catch { }
  },
  newPeer(id) {
    if (!window.Peer) { this.fail("Listen together needs internet. Check your connection and try again."); return null; }
    const p = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    p.on('error', e => this.onError(e));
    p.on('disconnected', () => { if (this.peer === p && !this.connected() && this.status !== 'idle') { try { p.reconnect(); } catch { } } });
    return p;
  },
  host() {
    this.leave(true); this.unlock();
    this.role = 'host'; this.code = this.makeCode(); this.status = 'starting'; this.err = '';
    this.peer = this.newPeer(this.peerId(this.code)); if (!this.peer) return;
    this.peer.on('open', () => { this.status = 'waiting'; refreshTogether(); });
    this.peer.on('connection', c => {
      if (this.connected()) { c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 400); }); return; }
      this.attach(c);
    });
    refreshTogether();
  },
  join(code) {
    code = String(code || '').trim().toUpperCase().replace(/\s+/g, '-');
    if (!/^[A-Z]+-?\d{2}$/.test(code)) { this.err = 'Enter the code exactly as shown, like RAGA-42'; refreshTogether(); return; }
    if (!code.includes('-')) code = code.replace(/(\d{2})$/, '-$1');
    this.leave(true); this.unlock();
    this.role = 'guest'; this.code = code; this.status = 'joining'; this.err = '';
    this.peer = this.newPeer(); if (!this.peer) return;
    this.peer.on('open', () => {
      const c = this.peer.connect(this.peerId(code), { reliable: true });
      this.attach(c);
      setTimeout(() => { if (this.status === 'joining' && !this.connected()) this.fail("Couldn't reach that session. Check the code and that the other phone has Isai open."); }, 15000);
    });
    refreshTogether();
  },
  attach(c) {
    this.conn = c;
    c.on('open', () => { this.send(this.helloMsg()); });
    c.on('data', d => this.onData(d));
    c.on('close', () => { if (this.conn === c) this.onClose(); });
    c.on('error', () => { });
  },
  send(m) { try { if (this.conn && this.conn.open) this.conn.send(m); } catch { } },
  onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      const first = !this.partner;
      if (Array.isArray(d.profiles)) mergeProfiles(d.profiles);
      this.partnerId = d.id;
      this.partner = PROFILES.find(p => p.id === d.id) || { name: String(d.name || 'Friend').slice(0, 30), avatar: d.avatar };
      this.status = 'connected';
      if (first) {
        this.send(this.helloMsg());
        toast(`Listening with ${this.partner.name}`);
        this.syncClock();
        if (this.role === 'host') setTimeout(() => { if (Player.cur) this.broadcast(); }, 1200);
        clearInterval(this.hb);
        this.hb = setInterval(() => { if (this.connected() && this.controller === ME.name && !audio.paused) this.broadcast(); }, 4000);
      }
      refreshTogether();
    } else if (d.t === 'profiles') { if (Array.isArray(d.profiles)) mergeProfiles(d.profiles); }
    else if (d.t === 'ping') this.send({ t: 'pong', a: d.a, b: Date.now() });
    else if (d.t === 'pong') this.onPong(d);
    else if (d.t === 'state') this.applyRemote(d);
    else if (d.t === 'react') { floatHeart(); toast(`${this.partner ? this.partner.name : 'They'} sent you a heart`, 1800); }
    else if (d.t === 'busy') { this.fail('That session already has two people.'); }
    else if (d.t === 'bye') this.onClose();
  },
  helloMsg() { return { t: 'hello', id: ME.id, name: ME.name, avatar: ME.avatar, profiles: PROFILES }; },
  sendProfiles() { if (this.connected()) this.send({ t: 'profiles', profiles: PROFILES }); },
  samples: [],
  syncClock() {
    this.samples = [];
    for (let i = 0; i < 5; i++) setTimeout(() => this.send({ t: 'ping', a: Date.now() }), i * 250);
  },
  onPong(d) {
    const now = Date.now(), rtt = now - d.a;
    this.samples.push({ rtt, off: d.b - (d.a + rtt / 2) });
    const best = this.samples.slice().sort((x, y) => x.rtt - y.rtt)[0];
    this.offset = best.off;
  },
  wireItem(p) {
    if (!p) return null;
    if (p.type === 'song') return { type: 'song', key: p.key, title: p.title, artist: p.artist, album: p.album, duration: p.duration };
    const c = Object.assign({}, p); delete c.desc; return c;
  },
  lastApplied: null, lastStateAt: 0,
  matchesApplied() {
    const la = this.lastApplied; if (!la) return false;
    const cur = Player.cur, key = cur ? cur.key : null, playing = !audio.paused;
    if (key !== la.key || playing !== la.playing) return false;
    if (!cur || cur.type === 'radio') return true;
    const expected = la.time + (la.playing ? (Date.now() - la.at) / 1000 : 0);
    return Math.abs((audio.currentTime || 0) - expected) < 1.5;
  },
  localEvent() {
    if (!this.connected() || this.isSilent()) return;
    clearTimeout(this.bt);
    this.bt = setTimeout(() => { if (!this.matchesApplied()) this.broadcast(); }, 250);
  },
  broadcast() {
    if (!this.connected() || this.isSilent()) return;
    const p = Player.cur;
    this.controller = ME.name; this.missing = null; this.lastApplied = null; this.lastStateAt = Date.now();
    this.send({ t: 'state', item: this.wireItem(p), playing: !!p && !audio.paused, time: audio.currentTime || 0, at: Date.now(), by: ME.name });
    updateTogetherBar();
  },
  resolve(item) {
    if (!item) return null;
    if (item.type !== 'song') return item;
    const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const t = norm(item.title), a = norm(item.artist);
    let hit = S.tracks.find(x => norm(x.title) === t && norm(x.artist) === a);
    if (!hit) { const byTitle = S.tracks.filter(x => norm(x.title) === t); if (byTitle.length === 1) hit = byTitle[0]; }
    return hit ? songP(hit) : null;
  },
  async applyRemote(s) {
    const sentAt = s.at - this.offset;
    if (sentAt < this.lastStateAt) return;
    this.lastStateAt = sentAt;
    this.controller = s.by;
    const item = this.resolve(s.item);
    const target = () => s.time + (s.playing ? Math.max(0, (Date.now() - sentAt) / 1000) : 0);
    const mark = playing => { this.lastApplied = { key: item ? item.key : (Player.cur ? Player.cur.key : null), playing, time: item ? target() : (audio.currentTime || 0), at: Date.now() }; };
    if (!s.item) { mark(false); audio.pause(); updateTogetherBar(); return; }
    if (!item) {
      mark(false);
      if (!audio.paused) audio.pause();
      if (!this.missing || this.missing.key !== s.item.key) toast(`You don't have "${s.item.title}". It's playing on ${s.by}'s phone.`, 4000);
      this.missing = s.item; updateTogetherBar(); return;
    }
    this.missing = null;
    mark(!!s.playing);
    if (!Player.cur || Player.cur.key !== item.key || !Player.ready || this.isSilent()) {
      Player.queue = [item]; Player.idx = 0; Player.original = null; Player.context = `Listening with ${s.by}`;
      await Player.load(false);
      await whenReady();
    }
    mark(!!s.playing);
    if (item.type !== 'radio' && isFinite(audio.duration)) {
      const t = target();
      if (Math.abs(audio.currentTime - t) > 0.7) { try { audio.currentTime = Math.min(t, Math.max(0, audio.duration - 0.5)); } catch { } }
    }
    if (s.playing && audio.paused) audio.play().catch(() => toast('Tap play to join in', 2500));
    else if (!s.playing && !audio.paused) audio.pause();
    mark(!!s.playing);
    updatePlayerUI(); updateTogetherBar();
  },
  react() { if (!this.connected()) return; this.send({ t: 'react' }); toast('Heart sent', 1200); },
  onError(e) {
    const type = e && e.type;
    if (type === 'unavailable-id' && this.role === 'host') { this.host(); return; }
    if (type === 'peer-unavailable') { this.fail('No session with that code. Check it and try again.'); return; }
    if (this.connected()) return;
    this.fail("Couldn't connect. Check your internet and try again.");
  },
  fail(msg) { const keepRole = this.role; this.leave(true); this.err = msg; this.status = 'idle'; this.role = keepRole === 'guest' ? null : null; refreshTogether(); toast(msg, 3500); },
  onClose() {
    const name = this.partner && this.partner.name;
    this.leave(true);
    if (name) toast(`${name} left the session`);
  },
  leave(silent = false) {
    if (!silent) this.send({ t: 'bye' });
    clearInterval(this.hb); clearTimeout(this.bt);
    const c = this.conn, p = this.peer;
    this.conn = null; this.peer = null; this.partner = null; this.controller = null; this.missing = null; this.lastApplied = null; this.lastStateAt = 0;
    this.status = 'idle'; this.role = null; this.code = '';
    try { c && c.close(); } catch { }
    try { p && p.destroy(); } catch { }
    updateTogetherBar(); refreshTogether();
    if (Player.cur && Player.context && Player.context.startsWith('Listening with')) Player.context = 'Isai';
  },
};
function whenReady() {
  return new Promise(res => {
    if (audio.readyState >= 1) return res();
    const t = setTimeout(res, 8000);
    audio.addEventListener('loadedmetadata', () => { clearTimeout(t); setTimeout(res, 60); }, { once: true });
  });
}
function floatHeart() {
  const h = document.createElement('div');
  h.className = 'float-heart'; h.innerHTML = icon('heart-f');
  h.style.left = (40 + Math.random() * 20) + '%';
  document.body.appendChild(h);
  setTimeout(() => h.remove(), 1800);
}
function updateTogetherBar() {
  const bar = $('#together');
  const on = Together.connected();
  document.body.classList.toggle('together-on', on);
  if (!on) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const who = Together.partner.name;
  const ctl = Together.missing ? `${esc(who)} is playing a song you don't have` : Together.controller === ME.name ? "You're choosing" : Together.controller ? `${esc(Together.controller)} is choosing` : 'Connected';
  bar.innerHTML = `<button class="tg-main" data-a="together">${avatarHTML(Together.partner, 26)}<span class="tg-text"><b>With ${esc(who)}</b><span>${ctl}</span></span></button>
    <button class="iconbtn" data-a="tg-heart" aria-label="Send a heart"><span class="acc">${icon('heart-f', 'sm')}</span></button>`;
}
let sheetKind = '';
function togetherSheet() { sheetKind = 'together'; renderTogetherSheet(); }
function refreshTogether() { if (sheetKind === 'together' && $('#sheet').classList.contains('on')) renderTogetherSheet(); updateTogetherBar(); }
function renderTogetherSheet() {
  const T = Together;
  let h = `<div style="font-weight:700;font-size:18px;margin-bottom:4px">Listen together</div>`;
  if (T.connected()) {
    h += `<div class="sheet-head" style="border:0;margin-top:8px">${avatarHTML(T.partner, 48)}<div><div style="font-weight:600">Listening with ${esc(T.partner.name)}</div><div class="muted" style="font-size:13px">Play, pause, skip, and seek stay in sync on both phones.</div></div></div>
      <button class="opt" data-a="tg-heart">${icon('heart-f')}Send a heart</button>
      <button class="opt danger" data-a="tg-leave">${icon('x')}Leave session</button>`;
  } else if (T.role === 'host') {
    h += `<p class="muted" style="font-size:14px;margin:6px 0 14px">Share this code. When the other phone joins, whatever you play plays there too.</p>
      <div class="tg-code">${T.status === 'starting' ? '<div class="spinner" style="margin:6px auto"></div>' : esc(T.code)}</div>
      ${T.status === 'waiting' ? `<div style="display:flex;gap:10px;justify-content:center;margin:14px 0"><button class="btn primary small" data-a="tg-share">${icon('upload', 'sm')} Share code</button></div><p class="muted" style="text-align:center;font-size:13px">Waiting for someone to join…</p>` : ''}
      <button class="opt danger" data-a="tg-leave">${icon('x')}Cancel</button>`;
  } else if (T.status === 'joining') {
    h += `<div class="spinner"></div><p class="muted" style="text-align:center;font-size:14px">Joining ${esc(T.code)}…</p><button class="opt danger" data-a="tg-leave">${icon('x')}Cancel</button>`;
  } else {
    h += `<p class="muted" style="font-size:14px;margin:6px 0 16px">Listen to the same thing at the same time on two phones, wherever you both are.</p>
      <button class="btn primary" style="width:100%" data-a="tg-host">${icon('users', 'sm')} Start a session</button>
      <div class="muted" style="text-align:center;font-size:13px;margin:16px 0 10px">or join one</div>
      <form data-f="tg-join" style="display:flex;gap:8px"><input id="tg-code" class="tg-input" placeholder="RAGA-42" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go"><button class="btn ghost" type="submit">Join</button></form>
      ${T.err ? `<p style="color:var(--danger);font-size:13px;margin-top:10px">${esc(T.err)}</p>` : ''}
      <p class="dim" style="font-size:12px;margin-top:16px">Podcasts, radio, and Discover music play on both phones. Your own songs play only if both phones have the same song.</p>`;
  }
  openSheet(h);
}

/* ---------- boot ---------- */
function boot() {
  let id = null;
  try { id = sessionStorage.getItem('isai-profile'); } catch { }
  if (id && PROFILES.some(p => p.id === id)) start(id);
  else showPicker(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || Player.cur && !audio.paused) return;
      reloaded = true; location.reload();
    });
  }
}
async function start(id) {
  ME = PROFILES.find(p => p.id === id);
  DB.name = dbNameFor(id);
  try { await DB.open(); }
  catch { $('#view').innerHTML = emptyHTML('x', 'Storage unavailable', 'Isai needs browser storage. Turn off private browsing and try again.'); return; }
  const [tracks, liked, playlists, podcasts, progress, recent, radioFavs, epDl, settings, player] = await Promise.all(
    [DB.all('tracks'), KV.get('liked'), KV.get('playlists'), KV.get('podcasts'), KV.get('progress'), KV.get('recent'), KV.get('radioFavs'), KV.get('epDl'), KV.get('settings'), KV.get('player')]);
  S.tracks = tracks || []; S.liked = new Set(liked || []); S.playlists = playlists || []; S.podcasts = podcasts || [];
  S.progress = progress || {}; S.recent = recent || []; S.radioFavs = radioFavs || []; S.epDl = epDl || {};
  S.settings = Object.assign({ jamendo: DEFAULT_JAMENDO, relay: '' }, settings || {});
  if (!S.settings.jamendo) S.settings.jamendo = DEFAULT_JAMENDO;
  if (player && player.queue && player.queue.length) {
    Object.assign(Player, { queue: player.queue, idx: Math.min(player.idx, player.queue.length - 1), context: player.context, shuffle: !!player.shuffle, repeat: player.repeat || 'off', speed: player.speed || 1, ready: false });
    if (Player.cur && Player.cur.type === 'song' && !trackById(Player.cur.id)) { Player.queue = []; Player.idx = -1; }
    if (Player.cur && Player.cur.type !== 'radio' && player.time) {
      const t = player.time;
      const orig = Player.load.bind(Player);
      Player.load = async auto => { Player.load = orig; await orig(auto); if (Player.cur && Player.cur.type === 'song') audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = t; } catch { } }, { once: true }); };
    }
  }
  history.replaceState({ l: 0 }, '');
  render();
  updatePlayerUI();
}
boot();
