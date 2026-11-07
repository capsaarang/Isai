'use strict';
/* Isai: personal music and podcast player. All data stays on this device. */

const VERSION = '1.7.1';
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
  putMany(s, pairs) { return this.req(s, 'readwrite', st => { for (const [k, v] of pairs) st.put(v, k); }); },
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
  plays: {}, stats: {}, meta: {}, others: {},
  libSort: 'title', libFilter: '',
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
  loadId: 0,
  async load(autoplay = true) {
    const p = this.cur;
    if (!p) return;
    this.loadId++;
    this.ready = false;
    if (this.objURL) { URL.revokeObjectURL(this.objURL); this.objURL = null; }
    let src = null;
    try {
      if (p.type === 'song') {
        let b = await DB.get('blobs', p.id);
        const t = trackById(p.id);
        if (!b && t && t.source === 'gdrive') {
          b = await Drive.readyGet(t);
          if (!b) {
            if (!navigator.onLine) throw new Error('offline');
            toast('Loading from Google Drive…', 0);
            b = await Drive.songBlob(t);
            toast('', 1);
          }
        }
        if (!b) throw new Error('missing');
        src = this.objURL = URL.createObjectURL(b);
      } else if (p.type === 'episode' && S.epDl[p.id]) {
        const b = await DB.get('blobs', 'ep:' + p.id);
        src = b ? (this.objURL = URL.createObjectURL(b)) : p.url;
      } else src = p.url;
    } catch (e) {
      toast('', 1);
      if (e && e.message === 'gdrive-auth') { if (document.hidden) toast('Open Isai to reconnect Google Drive'); else driveAuthSheet('play'); }
      else if (e && e.message === 'offline') toast("You're offline. Save Drive songs for offline to play them anywhere.", 3500);
      else toast("Couldn't open this song");
      return;
    }
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
    Drive.prefetchNext();
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
    if (Together.isFollower()) return Together.requestAdd(p, true);
    if (!this.cur) return this.play([p], 0, 'Queue');
    this.queue.splice(this.idx + 1, 0, p); saveState(); toast('Playing next'); Together.queueChanged();
  },
  addQueue(p) {
    if (Together.isFollower()) return Together.requestAdd(p, false);
    if (!this.cur) return this.play([p], 0, 'Queue');
    this.queue.push(p); saveState(); toast('Added to queue'); Together.queueChanged();
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
  p = Object.assign({}, p, { at: Date.now(), sk: pKey(p) || p.key });
  S.recent = [p, ...S.recent.filter(x => x.key !== p.key)].slice(0, 20);
  Sync.soon();
  saveKV.recent();
}

audio.addEventListener('timeupdate', () => {
  Stats.onTime();
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
audio.addEventListener('loadedmetadata', () => {
  updateProgressUI(); updateMediaSession();
  const p = Player.cur, t = p && p.type === 'song' && trackById(p.id);
  if (t && !t.duration && isFinite(audio.duration)) { t.duration = audio.duration; DB.put('tracks', t.id, t).catch(() => { }); }
});
audio.addEventListener('ended', () => {
  if (Together.isSilent()) return;
  if (Together.isFollower()) { const p0 = Player.cur; if (p0 && p0.type === 'episode') { S.progress[p0.id] = { t: 0, d: audio.duration, done: true, at: Date.now() }; saveKV.progress(); } return; }
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
    const tr = p.type === 'song' ? trackById(p.id) : null;
    const mark = tr && tr.source === 'gdrive' ? (tr.offline ? `<span class="acc src-mark" title="Saved offline">${icon('check', 'sm')}</span>` : `<span class="dim src-mark" title="Google Drive">${icon('cloud', 'sm')}</span>`) : '';
    const sub = p.type === 'radio' ? esc(p.sub || 'Radio') : mark + esc(p.sub || '') + (opts.dur && p.duration ? ' · ' + fmt(p.duration) : '');
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
const songsN = n => `${n} song${n === 1 ? '' : 's'}`;
const SORTS = [['title', 'A to Z'], ['artist', 'Artist'], ['added', 'Recently added'], ['length', 'Length'], ['plays', 'Most played']];
function sortTracks(list) {
  const by = S.libSort;
  if (by === 'artist') return list.sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.album.localeCompare(b.album) || (a.track || 0) - (b.track || 0) || sortTitle(a, b));
  if (by === 'added') return list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  if (by === 'length') return list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  if (by === 'plays') { const tp = Stats.totalPlays(); return list.sort((a, b) => ((tp[songKeyOf(b)] || {}).n || 0) - ((tp[songKeyOf(a)] || {}).n || 0) || sortTitle(a, b)); }
  return list.sort(sortTitle);
}
const matchFilter = (...vals) => { const q = S.libFilter.trim().toLowerCase(); return !q || vals.some(v => String(v || '').toLowerCase().includes(q)); };
function smartList(kind) {
  if (kind === 'most') { const tp = Stats.totalPlays(); return S.tracks.filter(t => (tp[songKeyOf(t)] || {}).n).sort((a, b) => tp[songKeyOf(b)].n - tp[songKeyOf(a)].n).slice(0, 50); }
  if (kind === 'recent') return S.tracks.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 50);
  if (kind === 'forgotten') { const tp = Stats.totalPlays(), cut = Date.now() - 30 * 864e5; return S.tracks.filter(t => { const p = tp[songKeyOf(t)]; return p && p.last < cut; }).sort((a, b) => tp[songKeyOf(a)].last - tp[songKeyOf(b)].last).slice(0, 50); }
  return [];
}
const SMART = { most: ['Most played', 'trending'], recent: ['Recently added', 'clock'], forgotten: ['Not played in a while', 'history'] };
function folderLists() {
  const m = new Map();
  for (const t of S.tracks) if (t.source === 'gdrive' && t.folderName) { if (!m.has(t.folderName)) m.set(t.folderName, []); m.get(t.folderName).push(t); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
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
  let h = `<div class="topbar" style="margin-bottom:6px"><span style="flex:1"></span>
    <button class="iconbtn" data-a="together" aria-label="Listen together">${icon('users')}</button>
    <button class="iconbtn" data-a="import" aria-label="Add songs">${icon('upload')}</button>
    <button class="iconbtn" data-a="go" data-v="settings" aria-label="Settings">${icon('gear')}</button></div>
    <h1 class="welcome">Welcome to the world of Isai</h1>`;
  if (!S.tracks.length && !S.podcasts.length && !S.recent.length) {
    return h + emptyHTML('music', 'Let\'s get started', 'Stream your music from Google Drive, follow podcasts, or explore free music and radio.',
      `<div style="display:flex;flex-direction:column;gap:10px;align-items:center">
        <button class="btn primary" data-a="${Drive.connected() ? 'drive-scan' : 'drive-connect'}">${icon('cloud', 'sm')} ${Drive.connected() ? 'Scan Google Drive' : 'Connect Google Drive'}</button>
        <button class="btn ghost" data-a="import">${icon('upload', 'sm')} Add from this phone</button>
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
  const chips = [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'], ...(S.tracks.some(t => t.source === 'gdrive') ? [['phone', 'On this phone']] : [])]
    .map(([k, l]) => `<button class="chip ${S.libTab === k ? 'on' : ''}" data-a="libtab" data-t="${k}">${l}</button>`).join('');
  let h = topbar('Your library', { right }) + `<div class="chips">${chips}</div>`;
  if (S.libTab === 'playlists') {
    const tile = (v, p, ic, title, sub, bg = 'var(--card)', fg = 'var(--acc)') => `<button class="row" data-a="go" data-v="${v}" data-p="${esc(p)}"><div class="art" style="width:46px;height:46px;background:${bg};color:${fg}">${icon(ic)}</div><div class="meta"><div class="t ellipsis">${esc(title)}</div><div class="s ellipsis">${esc(sub)}</div></div></button>`;
    h += `<div class="section-title" style="margin-top:4px">Made for you</div>`;
    h += tile('stats', 'month', 'chart', 'Your listening stats', 'Top songs, artists, and minutes');
    for (const [k, [name, ic]] of Object.entries(SMART)) { const n = smartList(k).length; h += tile('smart', k, ic, name, n ? songsN(n) : k === 'recent' ? 'Nothing yet' : 'Fills in as you listen'); }
    h += `<div class="section-title">Your playlists</div>`;
    h += `<button class="row" data-a="new-playlist"><div class="art" style="width:46px;height:46px;background:var(--card);color:var(--text)">${icon('plus')}</div><div class="meta"><div class="t">New playlist</div></div></button>`;
    h += `<button class="row" data-a="go" data-v="playlist" data-p="liked"><div class="art" style="width:46px;height:46px;background:#EF9F27;color:#2b1700">${icon('heart-f')}</div><div class="meta"><div class="t">Liked songs</div><div class="s">${songsN(S.liked.size)}</div></div></button>`;
    h += S.playlists.map(pl => `<button class="row" data-a="go" data-v="playlist" data-p="${esc(pl.id)}">${artHTML(plCover(pl), '', 46)}<div class="meta"><div class="t ellipsis">${esc(pl.name)}</div><div class="s">Playlist · ${songsN(pl.ids.length)}</div></div></button>`).join('');
    const fl = folderLists();
    if (fl.length) {
      h += `<div class="section-title">From your Drive folders</div>`;
      h += fl.map(([name, ts]) => tile('folder', name, 'folder', name.split(' / ').pop(), `${name.includes(' / ') ? name.split(' / ').slice(0, -1).join(' / ') + ' · ' : ''}${songsN(ts.length)}`)).join('');
    }
    return h;
  }
  if (!S.tracks.length) return h + emptyHTML('music', 'Add your first songs', 'Stream your music from Google Drive, or add songs from this phone.', `<div style="display:flex;flex-direction:column;gap:10px;align-items:center"><button class="btn primary" data-a="${Drive.connected() ? 'drive-scan' : 'drive-connect'}">${icon('cloud', 'sm')} ${Drive.connected() ? 'Scan Google Drive' : 'Connect Google Drive'}</button><button class="btn ghost" data-a="import">${icon('upload', 'sm')} Add from this phone</button></div>`);
  if (S.libTab === 'phone') {
    const on = songsSorted().filter(t => t.source !== 'gdrive' || t.offline).map(songP);
    h += `<div class="muted" style="font-size:13px;margin-bottom:4px">${on.length} song${on.length === 1 ? '' : 's'} ${on.length === 1 ? 'plays' : 'play'} without internet</div>`;
    h += on.length ? rowsHTML(on, 'On this phone', { dur: true }) : emptyHTML('download', 'Nothing saved yet', 'Use Save offline on any Google Drive song, album, or playlist.');
    return h;
  }
  h += `<div class="search lib-filter">${icon('search', 'sm')}<input id="lib-filter" type="search" placeholder="Filter ${S.libTab}" value="${esc(S.libFilter)}" autocomplete="off" enterkeyhint="search"></div>`;
  h += `<div id="lib-body">${libBodyHTML()}</div>`;
  return h;
};
Views.library.after = () => {
  const inp = $('#lib-filter'); if (!inp) return;
  inp.addEventListener('input', () => {
    S.libFilter = inp.value; S.lists = {};
    const b = $('#lib-body'); b.innerHTML = libBodyHTML(); hydrateArt(b); markPlayingRows();
  });
};
function libBodyHTML() {
  let h = '';
  if (S.libTab === 'songs') {
    const list = sortTracks(S.tracks.filter(t => matchFilter(t.title, t.artist, t.album)));
    h += `<div class="chips" style="margin-bottom:8px">${SORTS.map(([k, l]) => `<button class="chip ${S.libSort === k ? 'on' : ''}" data-a="lib-sort" data-t="${k}">${l}</button>`).join('')}</div>`;
    h += `<div class="enrich-line muted ${Enrich.line() ? '' : 'hidden'}">${esc(Enrich.line())}</div>`;
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span class="muted" style="font-size:13px">${list.length} song${list.length === 1 ? '' : 's'}</span><button class="btn small primary" data-a="shuffle-all">${icon('shuffle', 'sm')} Shuffle</button></div>`;
    h += list.length ? rowsHTML(list.map(songP), 'Your library', { dur: true }) : emptyHTML('search', 'No matches', 'Try another word.');
  } else if (S.libTab === 'albums') {
    h += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px">${albumsList().filter(a => matchFilter(a.name, a.artist)).map(a =>
      `<button class="card" style="width:auto" data-a="go" data-v="album" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 140).replace('class="art ', 'style="width:100%;height:auto;aspect-ratio:1" class="art ')}<div class="t ellipsis">${esc(a.name)}</div><div class="s ellipsis">${esc(a.artist)}</div></button>`).join('')}</div>`;
  } else {
    h += artistsList().filter(a => matchFilter(a.name)).map(a => `<button class="row" data-a="go" data-v="artist" data-p="${esc(a.name)}">${artHTML({ title: a.name, artId: a.artId }, '', 46).replace('class="art ', 'style="width:46px;height:46px;border-radius:50%" class="art ')}<div class="meta"><div class="t ellipsis">${esc(a.name)}</div><div class="s">${a.tracks.length} songs</div></div></button>`).join('');
  }
  return h;
}

function heroHTML(p, title, sub, round = false) {
  return `<div class="hero">${artHTML(p, '', 200).replace('class="art ', `style="width:200px;height:200px;${round ? 'border-radius:50%' : ''}" class="art `)}<h2>${esc(title)}</h2><div class="muted" style="font-size:14px">${esc(sub)}</div></div>`;
}
function playBar(L, extra = '') {
  const l = S.lists[L];
  const hasCloud = l && l.items.some(p => { const t = p.type === 'song' && trackById(p.id); return t && t.source === 'gdrive' && !t.offline; });
  if (hasCloud) extra += `<button class="iconbtn" data-a="save-list" data-l="${L}" aria-label="Save offline">${icon('download')}</button>`;
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
Views.smart = kind => {
  const [name, ic] = SMART[kind] || ['Songs', 'music'];
  const items = smartList(kind).map(songP);
  const L = reg(items, name);
  let h = topbar('', { back: true }) + `<div class="hero"><div class="art" style="width:200px;height:200px;background:var(--card);color:var(--acc)">${icon(ic).replace('class="icon ', 'class="icon xl ')}</div><h2>${esc(name)}</h2><div class="muted" style="font-size:14px">${items.length} songs · updates as you listen</div></div>`;
  if (!items.length) return h + emptyHTML(ic, kind === 'forgotten' ? "Nothing's gathering dust yet" : 'Nothing here yet', kind === 'forgotten' ? 'Songs you played over a month ago show up here.' : 'Play some songs and this list fills in.');
  return h + playBar(L) + rowsHTML(items, name, { dur: true });
};
Views.folder = name => {
  const ts = S.tracks.filter(t => t.source === 'gdrive' && t.folderName === name).sort((a, b) => (a.track || 0) - (b.track || 0) || sortTitle(a, b));
  const items = ts.map(songP), L = reg(items, name.split(' / ').pop());
  let h = topbar('', { back: true }) + `<div class="hero"><div class="art" style="width:200px;height:200px;background:var(--card);color:var(--acc)">${icon('folder').replace('class="icon ', 'class="icon xl ')}</div><h2>${esc(name.split(' / ').pop())}</h2><div class="muted" style="font-size:14px">Drive folder · ${items.length} songs</div></div>`;
  if (!items.length) return h + emptyHTML('folder', 'This folder is empty', 'Add songs to it in Google Drive.');
  return h + playBar(L) + rowsHTML(items, name, { dur: true });
};
Views.stats = () => {
  const months = Stats.months(), cur = monthKey();
  const sel = S.statsMonth || cur;
  const label = m => m === 'year' ? `${new Date().getFullYear()} so far` : new Date(m + '-15').toLocaleDateString(undefined, { month: 'long', year: m.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' });
  const opts = [...new Set([cur, ...months])].slice(0, 12);
  let h = topbar('Your listening stats', { back: true });
  h += `<div class="chips">${[...opts, 'year'].map(m => `<button class="chip ${sel === m ? 'on' : ''}" data-a="stats-month" data-t="${m}">${m === cur ? 'This month' : esc(label(m))}</button>`).join('')}</div>`;
  const st = Stats.month(sel), tp = Stats.totalPlays();
  const mins = Math.round(st.secs / 60);
  const songs = Object.entries(st.songs).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const artists = Object.entries(st.artists).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const plays = Object.values(st.songs).reduce((a, b) => a + b, 0);
  h += `<div class="stat-tiles"><div class="stat"><div class="n">${st.secs > 0 && mins < 1 ? '&lt;1' : mins.toLocaleString()}</div><div class="l">minutes listened</div></div><div class="stat"><div class="n">${plays.toLocaleString()}</div><div class="l">songs played</div></div><div class="stat"><div class="n">${Object.keys(st.artists).length.toLocaleString()}</div><div class="l">artists</div></div></div>`;
  if (!songs.length) return h + emptyHTML('chart', 'No listening yet', `Play some music and your stats for ${sel === 'year' ? 'this year' : label(sel)} show up here.`);
  const km = keyMap();
  const items = [], rows = [];
  songs.forEach(([k, n], i) => {
    const id = km.get(k), meta = tp[k] || {};
    if (id) { items.push(songP(trackById(id))); rows.push({ k, n, i, idx: items.length - 1 }); } else rows.push({ k, n, i, title: meta.title || 'Song', artist: meta.artist || '' });
  });
  const L = reg(items, 'Your top songs');
  h += `<div class="section-title">Top songs</div><div class="list">` + rows.map(r => {
    if (r.idx != null) { const p = items[r.idx]; return `<div class="row" data-key="${esc(p.key)}"><span class="rank">${r.i + 1}</span><button class="row" style="padding:0;min-height:0;flex:1;min-width:0" data-a="play" data-l="${L}" data-i="${r.idx}">${artHTML(p, '', 46)}<div class="meta"><div class="t ellipsis">${esc(p.title)}</div><div class="s ellipsis">${esc(p.sub || '')}</div></div></button><span class="muted plays">${r.n} play${r.n === 1 ? '' : 's'}</span></div>`; }
    return `<div class="row"><span class="rank">${r.i + 1}</span>${artHTML({ title: r.title }, '', 46)}<div class="meta"><div class="t ellipsis">${esc(r.title)}</div><div class="s ellipsis">${esc(r.artist)}</div></div><span class="muted plays">${r.n} play${r.n === 1 ? '' : 's'}</span></div>`;
  }).join('') + `</div>`;
  h += `<div class="section-title">Top artists</div><div class="list">` + artists.map(([a, n], i) => `<button class="row" data-a="go" data-v="artist" data-p="${esc(a)}"><span class="rank">${i + 1}</span>${artHTML({ title: a }, '', 46).replace('class="art ', 'style="width:46px;height:46px;border-radius:50%" class="art ')}<div class="meta"><div class="t ellipsis">${esc(a)}</div></div><span class="muted plays">${n} play${n === 1 ? '' : 's'}</span></button>`).join('') + `</div>`;
  if (Object.keys(S.others || {}).length) h += `<p class="dim" style="font-size:12px;margin-top:16px">Includes listening from both phones.</p>`;
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
    <div class="section-title">This phone</div>
    <div class="setting-row"><span>Name in Listen together</span><button class="acc" data-a="rename-phone">${esc(DeviceName.get())}</button></div>
    <div class="section-title">Google Drive</div>
    ${Drive.connected() ? `
      <div class="setting-row"><span>Account</span><span class="muted ellipsis" style="max-width:60%">${esc(S.settings.gdrive.email)}</span></div>
      <div class="setting-row"><span>Music folder</span><button class="acc" data-a="drive-folder">${esc(S.settings.gdrive.folderName || 'Choose')}</button></div>
      <div class="setting-row"><span>Songs from Drive</span><span class="muted">${S.tracks.filter(t => t.source === 'gdrive').length} (${S.tracks.filter(t => t.source === 'gdrive' && t.offline).length} offline)</span></div>
      <div class="enrich-line muted ${Enrich.line() ? '' : 'hidden'}" style="padding-top:10px">${esc(Enrich.line())}</div>
      <div class="setting-row"><span>Last scanned</span><span class="muted">${S.settings.gdrive.lastScan ? esc(relDate(S.settings.gdrive.lastScan)) + ' ' + new Date(S.settings.gdrive.lastScan).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not yet'}</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
        <button class="btn small primary" data-a="drive-scan">${icon('refresh', 'sm')} Scan for new songs</button>
        <button class="btn small ghost" data-a="drive-disconnect">Disconnect</button>
      </div>` : `
      <p class="muted" style="font-size:13px">Stream your music from a Google Drive folder without using phone storage. Isai can only read files, never change or delete them.</p>
      <button class="btn primary" data-a="drive-connect">${icon('cloud', 'sm')} Connect Google Drive</button>`}
    <div class="section-title">Sync between phones</div>
    ${(() => {
      const st = Sync.state();
      if (st === 'no-drive') return `<p class="muted" style="font-size:13px">Connect Google Drive above to keep likes, playlists, history, and stats the same on both phones.</p>`;
      if (st === 'needs-permission') return `<p class="muted" style="font-size:13px">Keeps likes, playlists, history, stats, stations, and followed shows the same on both phones, using a hidden Isai file in your Drive that only Isai can see. Needs one more Google permission.</p><button class="btn small primary" data-a="drive-connect" data-p="sync">Turn on sync</button>`;
      return `<div class="setting-row"><span>Status</span><span class="${st === 'on' && Sync.err !== 'failed' ? 'acc' : 'muted'}">${st === 'paused' ? 'Paused until Google reconnects' : Sync.err === 'failed' ? 'Last try failed' : 'On'}</span></div>
        <div class="setting-row"><span>Last synced</span><span class="muted">${Sync.lastAt ? esc(relDate(Sync.lastAt)) + ' ' + new Date(Sync.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not yet'}</span></div>
        <div style="margin-top:12px"><button class="btn small ghost" data-a="sync-now">${icon('refresh', 'sm')} Sync now</button></div>`;
    })()}
    <div class="section-title">Backup</div>
    <p class="muted" style="font-size:13px">Saves your likes, playlists, history, stats, stations, followed shows, and podcast progress to a file. Songs aren't included.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn small primary" data-a="backup">${icon('download', 'sm')} Back up now</button>
      <button class="btn small ghost" data-a="restore">${icon('upload', 'sm')} Restore from file</button>
    </div>
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
    if (t && t.source === 'gdrive') h += t.offline ? opt('s-unoffline', 'trash', 'Remove offline copy') : opt('s-offline', 'download', 'Save offline');
    h += opt('s-addpl', 'plus', 'Add to playlist');
    h += opt('s-like', S.liked.has(p.id) ? 'heart-f' : 'heart', S.liked.has(p.id) ? 'Remove from liked songs' : 'Add to liked songs');
    if (t) { h += opt('s-album', 'album', 'Go to album') + opt('s-artist', 'user', 'Go to artist'); }
    if (plId && plId !== 'liked') h += opt('s-unpl', 'x', 'Remove from this playlist', `data-p="${esc(plId)}"`);
    h += opt('s-delete', 'trash', t && t.source === 'gdrive' ? 'Hide from Isai (stays in Drive)' : 'Remove from library', '', 'danger');
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
  sheetKind = 'queue';
  if (Together.isFollower()) {
    const cur = Player.cur, up = Together.remoteQueue || [];
    const r = p => `<div class="qrow">${artHTML(p, '', 40).replace('class="art ', 'style="width:40px;height:40px" class="art ')}<div class="meta"><div class="t ellipsis">${esc(p.title)}</div><div class="s ellipsis">${esc(p.sub || p.artist || '')}</div></div></div>`;
    let h = `<div style="font-weight:700;font-size:17px;margin-bottom:8px">Now playing</div>${cur ? r(cur) : ''}`;
    h += `<div style="font-weight:700;font-size:17px;margin:16px 0 6px">Up next on ${esc(Together.controller)}</div>`;
    h += up.length ? up.map(r).join('') : `<p class="muted" style="font-size:13px">Nothing queued yet.</p>`;
    h += `<p class="dim" style="font-size:12px;margin-top:14px">Add songs from any song's menu with Play next or Add to queue. They go into this shared list.</p>`;
    openSheet(h); return;
  }
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
  const pl = { id: 'p' + uid(), name, ids: firstId ? [firstId] : [], createdAt: Date.now(), updatedAt: Date.now() };
  S.playlists.unshift(pl); await saveKV.playlists(); Sync.soon();
  return pl;
}
async function deleteTrack(id) {
  const sk = songKeyOf(trackById(id));
  S.playlists.forEach(pl => { if (pl.ids.includes(id) && sk) pl.extraKeys = [...new Set([...(pl.extraKeys || []), sk])]; });
  await DB.del('blobs', id); await DB.del('blobs', 'tmp:' + id); await DB.del('art', id); await DB.del('tracks', id);
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
  'shuffle-all': () => { const items = S.tracks.filter(t => matchFilter(t.title, t.artist, t.album)).map(songP); if (!items.length) return; Player.shuffle = true; Player.play(items, Math.floor(Math.random() * items.length), 'Your library'); },
  more: (d, el) => { const p = listItem(d); if (p) itemSheet(p, el.dataset.pl); },
  'fav-radio': d => { const p = listItem(d); if (p) toggleFav(p); },
  'dl-ep': d => { const p = listItem(d); if (!p) return; if (S.epDl[p.id]) itemSheet(p); else downloadEpisode(p); },
  libtab: d => { S.libTab = d.t; S.libFilter = ''; render(); },
  'lib-sort': d => { S.libSort = d.t; const b = $('#lib-body'); if (b) { S.lists = {}; b.innerHTML = libBodyHTML(); hydrateArt(b); markPlayingRows(); } },
  'stats-month': d => { S.statsMonth = d.t; rerenderKeepScroll(); },
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
    S.podcasts.push(pod); touch('pods', pod.feedUrl, true, { pod: podStub(pod) });
    await saveKV.podcasts(); toast('Following ' + pod.title); rerenderKeepScroll();
  },
  unsub: async d => {
    if (!confirm('Unfollow this show? Downloaded episodes stay in Downloads.')) return;
    const pod = S.podcasts.find(p => p.id === d.p);
    S.podcasts = S.podcasts.filter(p => p.id !== d.p); if (pod) { S.feedCache[pod.id] = pod; touch('pods', pod.feedUrl, false); }
    await saveKV.podcasts(); rerenderKeepScroll();
  },
  'refresh-pods': () => refreshPodcasts(true),
  'new-playlist': async () => { const pl = await newPlaylist(); if (pl) go('playlist', pl.id); },
  'pl-more': d => {
    const pl = S.playlists.find(p => p.id === d.p); if (!pl) return;
    openSheet(`<div class="sheet-head">${artHTML(plCover(pl), '', 48)}<div style="font-weight:600">${esc(pl.name)}</div></div>` + opt('pl-rename', 'edit', 'Rename', `data-p="${esc(pl.id)}"`) + opt('pl-delete', 'trash', 'Delete playlist', `data-p="${esc(pl.id)}"`, 'danger'));
  },
  'pl-rename': async d => { const pl = S.playlists.find(p => p.id === d.p); const n = (prompt('Rename playlist', pl.name) || '').trim(); if (n) { pl.name = n; plTouch(pl); await saveKV.playlists(); } closeSheet(); setTimeout(rerenderKeepScroll, 60); },
  'pl-delete': async d => { if (!confirm('Delete this playlist? Songs stay in your library.')) return; S.playlists = S.playlists.filter(p => p.id !== d.p); S.meta.plDel = S.meta.plDel || {}; S.meta.plDel[d.p] = Date.now(); saveMeta(); Sync.soon(); await saveKV.playlists(); closeSheet(); setTimeout(() => closeTop(), 80); },
  's-next': () => { Player.addNext(sheetItem); closeSheet(); },
  's-queue': () => { Player.addQueue(sheetItem); closeSheet(); },
  's-addpl': () => playlistPicker(sheetItem),
  'pl-add': async d => {
    const pl = S.playlists.find(p => p.id === d.p);
    if (pl.ids.includes(sheetItem.id)) toast('Already in ' + pl.name);
    else { pl.ids.push(sheetItem.id); plTouch(pl); await saveKV.playlists(); toast('Added to ' + pl.name); }
    closeSheet();
  },
  'pl-new-add': async () => { const pl = await newPlaylist(sheetItem.id); if (pl) toast('Added to ' + pl.name); closeSheet(); },
  's-like': async () => { await toggleLike(sheetItem.id); closeSheet(); },
  's-album': () => { const a = sheetItem.album; closeSheet(); setTimeout(() => go('album', a), 60); },
  's-artist': () => { const a = sheetItem.artist; closeSheet(); setTimeout(() => go('artist', a), 60); },
  's-unpl': async d => { const pl = S.playlists.find(p => p.id === d.p); pl.ids = pl.ids.filter(x => x !== sheetItem.id); const sk = songKeyOf(trackById(sheetItem.id)); pl.extraKeys = (pl.extraKeys || []).filter(k => k !== sk); plTouch(pl); await saveKV.playlists(); closeSheet(); setTimeout(rerenderKeepScroll, 60); },
  's-delete': async () => {
    const tr = trackById(sheetItem.id);
    const drive = tr && tr.source === 'gdrive';
    if (!confirm(drive ? `Hide "${sheetItem.title}" from Isai? It stays in your Google Drive.` : `Remove "${sheetItem.title}" from Isai? The original file isn't touched.`)) return;
    if (drive && S.settings.gdrive) { S.settings.gdrive.hidden = [...new Set([...(S.settings.gdrive.hidden || []), tr.driveId])]; await saveKV.settings(); }
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
  'q-remove': d => { const j = +d.i; Player.queue.splice(j, 1); if (j < Player.idx) Player.idx--; saveState(); Together.queueChanged(); queueSheet(); },
  'q-clear': () => { Player.queue = Player.queue.slice(0, Player.idx + 1); Player.original = null; saveState(); Together.queueChanged(); queueSheet(); },
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
  'clear-recent': async () => { S.recent = []; S.meta.recentClear = Date.now(); saveMeta(); Sync.soon(); await saveKV.recent(); toast('Cleared'); },
  'rename-phone': () => {
    const n = (prompt("This phone's name", DeviceName.get()) || '').trim().slice(0, 24);
    if (!n) return;
    DeviceName.set(n); toast('Name updated', 1400); rerenderKeepScroll();
    if (Together.connected()) Together.send(Together.helloMsg());
  },
  'drive-connect': d => Drive.connect(d.p && typeof d.p === 'string' ? d.p : 'setup'),
  'drive-renew': async d => {
    const ok = await Drive.quickRenew();
    if (ok) { closeSheet(); toast('Google Drive reconnected', 1600); setTimeout(() => Enrich.run(), 500); if (d.p === 'scan') setTimeout(driveScan, 300); else if (d.p === 'sync') Sync.run(); else if (Player.cur && !Player.ready) Player.load(true); return; }
    Drive.connect(d.p || 'play');
  },
  'sync-now': async () => {
    if (Sync.state() === 'paused') return driveAuthSheet('sync');
    toast('Syncing…', 0); const ok = await Sync.run(); toast(ok ? 'Synced' : "Couldn't sync right now", 2000); rerenderKeepScroll();
  },
  backup: () => backupNow(),
  restore: () => $('#restore-input').click(),
  'drive-scan': () => { if (!Drive.connected()) return Drive.connect('setup'); if (!S.settings.gdrive.folderId) return driveFolderSheet(); driveScan(); },
  'drive-folder': () => driveFolderSheet(),
  'drive-disconnect': async () => {
    if (!confirm('Disconnect Google Drive? Drive songs leave Isai on this phone, but your likes, playlists, and stats are kept. When you connect a Drive with the same songs, they come back. Nothing in your Drive changes.')) return;
    const t = Drive.token();
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => { });
    Drive.clearToken();
    await forgetOldDrive();
    S.settings.gdrive = null; await saveKV.settings();
    toast('Google Drive disconnected'); rerenderKeepScroll();
  },
  's-offline': () => { const t = trackById(sheetItem.id); closeSheet(); saveOffline(t); },
  's-unoffline': () => { const t = trackById(sheetItem.id); closeSheet(); removeOffline(t); },
  'save-list': d => { const l = S.lists[d.l]; if (l) saveListOffline(l.items); },
  together: () => togetherSheet(),
  'tg-host': () => Together.host(),
  'tg-leave': () => { Together.leave(); closeSheet(); },
  'tg-heart': () => Together.react(),
  'tg-share': async () => {
    const text = `Join me on Isai. Open Listen together and enter code ${Together.code}`;
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch { return; }
    try { await navigator.clipboard.writeText(Together.code); toast('Code copied'); } catch { toast('Code: ' + Together.code, 4000); }
  },

};
async function toggleLike(id) {
  const on = !S.liked.has(id);
  if (on) { S.liked.add(id); toast('Added to liked songs', 1400); } else { S.liked.delete(id); toast('Removed from liked songs', 1400); }
  touch('liked', songKeyOf(trackById(id)), on);
  await saveKV.liked();
  updatePlayerUI(); rerenderKeepScroll();
}
async function toggleFav(p) {
  const on = S.radioFavs.some(s => s.key === p.key);
  S.radioFavs = on ? S.radioFavs.filter(s => s.key !== p.key) : [p, ...S.radioFavs];
  touch('radio', p.key, !on, { item: p });
  await saveKV.radioFavs();
  toast(on ? 'Removed from your stations' : 'Added to your stations', 1400);
  updatePlayerUI();
  if (S.disc.radio) S.disc.radio.html = null;
  rerenderKeepScroll();
}

document.addEventListener('click', e => {
  if (Drive.connected() && !Drive.renewing && Date.now() - Drive.lastRenewTry > 120000 && Drive.minutesLeft() < 10 && !e.target.closest('[data-a="drive-renew"],[data-a="drive-connect"]')) {
    if (window.google && google.accounts && google.accounts.oauth2) Drive.quickRenew().then(ok => { if (ok) Enrich.run(); });
    else Drive.loadGIS();
  }
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); e.stopPropagation(); fn(el.dataset, el); }
});
document.addEventListener('submit', async e => {
  const f = e.target.dataset.f; if (!f) return;
  e.preventDefault();
  if (f === 'drive-folder') { const v = $('#drive-folder').value; $('#drive-folder').blur(); useDriveFolder(v); return; }
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
$('#restore-input').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) restoreFrom(f); });
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
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveState(); Sync.run(); } });

/* ---------- this phone's name ---------- */
const DeviceName = {
  get() {
    try { const n = localStorage.getItem('isai-device-name'); if (n) return n; } catch { }
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'Phone 2' : 'Phone 1';
  },
  set(n) { try { localStorage.setItem('isai-device-name', n); } catch { } },
};

/* ---------- google drive ---------- */
const GDRIVE_CLIENT_ID = '59416505369-4iqnmjv8pgsvahurv8r6mvon8g2g7ljh.apps.googleusercontent.com';
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
const GDRIVE_REDIRECT = location.hostname === 'capsaarang.github.io' ? 'https://capsaarang.github.io/Isai/' : location.origin + location.pathname.replace(/index\.html$/, '');
const AUDIO_MIME_RE = /^audio\//;
let drivePending = null;
const Drive = {
  tokKey() { return 'isai-gtoken-' + (ME ? ME.id : 'x'); },
  tokInfo() { try { return JSON.parse(localStorage.getItem(this.tokKey()) || 'null'); } catch { return null; } },
  token() { const t = this.tokInfo(); return t && t.exp > Date.now() + 60000 ? t.token : null; },
  minutesLeft() { const t = this.tokInfo(); return t ? (t.exp - Date.now()) / 60000 : -1; },
  saveToken(token, expiresIn, scope) {
    try { localStorage.setItem(this.tokKey(), JSON.stringify({ token, exp: Date.now() + (parseInt(expiresIn) || 3600) * 1000, scope: scope || GDRIVE_SCOPE })); } catch { }
  },
  hasSyncScope() { const t = this.tokInfo(); return !!(t && t.token && String(t.scope || '').includes('drive.appdata')); },
  gisLoading: null, renewing: false, lastRenewTry: 0,
  loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve(true);
    if (this.gisLoading) return this.gisLoading;
    this.gisLoading = new Promise(res => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = () => res(!!(window.google && google.accounts && google.accounts.oauth2));
      sc.onerror = () => { this.gisLoading = null; res(false); };
      document.head.appendChild(sc);
    });
    return this.gisLoading;
  },
  quickRenew() {
    // Must run inside a tap. Opens Google's own popup, which closes itself when access is still granted.
    if (!(window.google && google.accounts && google.accounts.oauth2) || this.renewing) return Promise.resolve(false);
    this.renewing = true; this.lastRenewTry = Date.now();
    return new Promise(res => {
      let done = false;
      const finish = ok => { if (done) return; done = true; this.renewing = false; res(ok); };
      try {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GDRIVE_CLIENT_ID, scope: GDRIVE_SCOPE, prompt: '',
          hint: S.settings.gdrive && S.settings.gdrive.email,
          callback: r => { if (r && r.access_token) { this.saveToken(r.access_token, r.expires_in, r.scope); finish(true); } else finish(false); },
          error_callback: () => finish(false),
        });
        client.requestAccessToken({ prompt: '' });
      } catch { finish(false); }
      setTimeout(() => finish(false), 45000);
    });
  },
  clearToken() { try { localStorage.removeItem(this.tokKey()); } catch { } },
  connected() { return !!(S.settings.gdrive && S.settings.gdrive.email); },
  connect(pending = 'setup') {
    const nonce = uid();
    try { sessionStorage.setItem('isai-gauth', JSON.stringify({ nonce, profile: ME.id, pending })); } catch { }
    try { audio.pause(); saveState(); } catch { }
    const g = S.settings.gdrive;
    const q = new URLSearchParams({ client_id: GDRIVE_CLIENT_ID, redirect_uri: GDRIVE_REDIRECT, response_type: 'token', scope: GDRIVE_SCOPE, include_granted_scopes: 'true', state: nonce });
    if (g && g.email) q.set('login_hint', g.email); else q.set('prompt', 'select_account consent');
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
  },
  async api(path, params) {
    const t = this.token(); if (!t) throw new Error('gdrive-auth');
    const r = await fetch('https://www.googleapis.com/drive/v3/' + path + (params ? '?' + new URLSearchParams(params) : ''), { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401) { this.clearToken(); throw new Error('gdrive-auth'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },
  async fileBlob(id, range) {
    const t = this.token(); if (!t) throw new Error('gdrive-auth');
    const headers = { Authorization: 'Bearer ' + t }; if (range) headers.Range = range;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers });
    if (r.status === 401) { this.clearToken(); throw new Error('gdrive-auth'); }
    if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
    return r.blob();
  },
  READY_AHEAD: 6, READY_MAX: 16,
  async readyGet(t) { try { return await DB.get('blobs', 'tmp:' + t.id); } catch { return null; } },
  async readyPut(t, b) {
    try {
      await DB.put('blobs', 'tmp:' + t.id, b);
      let list = (await KV.get('readyCache')) || [];
      list = [t.id, ...list.filter(x => x !== t.id)];
      for (const old of list.slice(this.READY_MAX)) await DB.del('blobs', 'tmp:' + old);
      await KV.set('readyCache', list.slice(0, this.READY_MAX));
    } catch { }
  },
  async readyClear() {
    const list = (await KV.get('readyCache')) || [];
    for (const id of list) await DB.del('blobs', 'tmp:' + id).catch(() => { });
    await KV.set('readyCache', []);
  },
  async songBlob(t) {
    const ready = await this.readyGet(t);
    if (ready) return ready;
    const b = await this.fileBlob(t.driveId);
    this.readyPut(t, b);
    return b;
  },
  prefetching: false,
  async prefetchNext() {
    if (this.prefetching || !this.token() || !navigator.onLine) return;
    this.prefetching = true;
    try {
      const ahead = Player.queue.slice(Player.idx + 1, Player.idx + 1 + this.READY_AHEAD);
      for (const n of ahead) {
        if (!n || n.type !== 'song' || !this.token()) continue;
        const t = trackById(n.id);
        if (!t || t.source !== 'gdrive' || t.offline) continue;
        if (await this.readyGet(t)) continue;
        try { await this.readyPut(t, await this.fileBlob(t.driveId)); } catch { break; }
      }
    } finally { this.prefetching = false; }
  },
  qEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); },
  async findFolders(name) {
    const d = await this.api('files', { q: `mimeType='application/vnd.google-apps.folder' and name='${this.qEsc(name)}' and trashed=false`, fields: 'files(id,name,modifiedTime)', pageSize: '20', spaces: 'drive' });
    return d.files || [];
  },
  async listAudio(folderId, onProgress) {
    const out = [], folders = [{ id: folderId, name: null }], seenFolders = new Set();
    while (folders.length) {
      const fo = folders.shift(), fid = fo.id;
      if (seenFolders.has(fid)) continue; seenFolders.add(fid);
      let pageToken = '';
      do {
        const params = { q: `'${this.qEsc(fid)}' in parents and trashed=false`, fields: 'nextPageToken,files(id,name,mimeType,size)', pageSize: '1000', spaces: 'drive' };
        if (pageToken) params.pageToken = pageToken;
        const d = await this.api('files', params);
        for (const f of d.files || []) {
          if (f.mimeType === 'application/vnd.google-apps.folder') folders.push({ id: f.id, name: fo.name ? fo.name + ' / ' + f.name : f.name });
          else if (AUDIO_MIME_RE.test(f.mimeType || '') || AUDIO_RE.test(f.name)) out.push(Object.assign(f, { folderName: fo.name }));
        }
        if (onProgress) onProgress(out.length);
        pageToken = d.nextPageToken || '';
      } while (pageToken);
    }
    return out;
  },
};
function tagsToTrack(tags, fileName) {
  const clean = s => (s == null ? '' : String(s)).replace(/\0/g, '').trim();
  const base = fileName.replace(/\.[^.]+$/, '').replace(/^(?:\d+\s*[._-]?\s*-?\s*)+(?=\D)/, '').trim() || fileName.replace(/\.[^.]+$/, '');
  let title = clean(tags.title), artist = clean(tags.artist);
  if (!title) {
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m && !artist && !/^\d+$/.test(m[1].trim())) { artist = m[1]; title = m[2]; } else title = base;
  }
  return { title, artist: artist || 'Unknown artist', album: clean(tags.album) || 'Unknown album', year: clean(tags.year), track: parseInt(tags.track) || 0 };
}
function handleDriveRedirect() {
  const h = location.hash || '';
  if (!/access_token=|error=/.test(h)) return;
  const p = new URLSearchParams(h.slice(1));
  let st = null;
  try { st = JSON.parse(sessionStorage.getItem('isai-gauth') || 'null'); sessionStorage.removeItem('isai-gauth'); } catch { }
  history.replaceState(null, '', location.pathname + location.search);
  if (!st || p.get('state') !== st.nonce) return;
  if (p.get('access_token')) {
    Drive.saveToken(p.get('access_token'), p.get('expires_in'), p.get('scope'));
    drivePending = st.pending || 'setup';
  } else {
    drivePending = 'denied';
  }
}
async function runDrivePending() {
  const what = drivePending; drivePending = null;
  if (!what) return;
  if (what === 'denied') { toast("Google Drive wasn't connected", 3000); return; }
  try {
    const me = await Drive.api('about', { fields: 'user(emailAddress,displayName)' });
    const email = me.user && me.user.emailAddress;
    const prev = S.settings.gdrive;
    if (prev && prev.email && email && prev.email !== email) {
      await forgetOldDrive();
      S.settings.gdrive = { email };
      toast(`Switched to ${email}`, 2000);
    } else S.settings.gdrive = Object.assign({}, prev || {}, { email });
    await saveKV.settings();
    if (what === 'play') { toast('Google Drive reconnected. Tap play to continue.', 3000); Enrich.run(); return; }
    if (what === 'sync') { const ok = await Sync.run(); toast(ok ? 'Sync is on' : "Couldn't turn on sync. Try again.", 2500); rerenderKeepScroll(); return; }
    if (!S.settings.gdrive.folderId) { await useDriveFolder('Isai', true); return; }
    if (what === 'scan' || what === 'setup') driveScan();
  } catch (e) {
    toast(e.message === 'gdrive-auth' ? "Google sign-in didn't finish. Try again." : "Couldn't reach Google Drive. Check your internet.", 3500);
  }
}
async function useDriveFolder(name, auto = false) {
  name = String(name || '').trim(); if (!name) return;
  try {
    const found = await Drive.findFolders(name);
    if (!found.length) {
      if (auto) driveFolderSheet(`No folder named "${name}" in this Google Drive yet. Type the folder that has your music.`);
      else toast(`No folder named "${name}" found`, 3000);
      return;
    }
    const f = found[0];
    S.settings.gdrive = Object.assign({}, S.settings.gdrive, { folderId: f.id, folderName: f.name });
    await saveKV.settings();
    closeSheet();
    toast(`Using "${f.name}" from Google Drive`, 1800);
    setTimeout(driveScan, 300);
  } catch (e) {
    if (e.message === 'gdrive-auth') return driveAuthSheet('scan');
    toast("Couldn't reach Google Drive. Check your internet.", 3000);
  }
}
function driveFolderSheet(msg = '') {
  openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:6px">Music folder in Google Drive</div>
    <p class="muted" style="font-size:14px;margin:0 0 14px">${esc(msg || 'Type the name of the Drive folder with your music. Folders inside it are included too.')}</p>
    <form data-f="drive-folder" style="display:flex;gap:8px"><input id="drive-folder" class="tg-input" style="text-transform:none;letter-spacing:0" value="${esc((S.settings.gdrive && S.settings.gdrive.folderName) || 'Isai')}" autocomplete="off" spellcheck="false"><button class="btn primary" type="submit">Use</button></form>`);
}
function driveAuthSheet(pending = 'play') {
  Drive.loadGIS();
  openSheet(`<div style="font-weight:700;font-size:17px;margin-bottom:6px">Reconnect Google Drive</div>
    <p class="muted" style="font-size:14px;margin:0 0 16px">Google needs a quick check about once an hour. Tap below. A Google window may flash open and close by itself.</p>
    <button class="btn primary" style="width:100%" data-a="drive-renew" data-p="${esc(pending)}">Reconnect</button>`);
}
/* reads title, artist, album, and cover art in the background, 5 songs at a time */
function syncsafe(b, o) { return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }
async function readDriveTags(t) {
  const isMp3 = /\.mp3$/i.test(t.fileKey + (t.mime || '')) || /mpeg/i.test(t.mime || '') || /\.mp3$/i.test(t.title || '');
  let head = await Drive.fileBlob(t.driveId, 'bytes=0-65535');
  const b = new Uint8Array(await head.slice(0, 10).arrayBuffer());
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const need = Math.min(syncsafe(b, 6) + 10 + (b[5] & 0x10 ? 10 : 0), 3 * 1048576);
    if (need > head.size && head.size >= 65536) head = await Drive.fileBlob(t.driveId, `bytes=0-${need - 1}`);
  } else if (!isMp3 && head.size >= 65536) {
    head = await Drive.fileBlob(t.driveId, 'bytes=0-393215');
  }
  return readTags(new File([head], 'x', { type: head.type || t.mime || 'audio/mpeg' }));
}
const Enrich = {
  active: false, done: 0, total: 0, paused: false, lastRender: 0,
  pending() { return S.tracks.filter(t => t.source === 'gdrive' && t.tagged === false); },
  line() { return this.active && this.total ? `Reading song details: ${this.done} of ${this.total}` : this.paused ? 'Song details paused until Google reconnects' : ''; },
  showLine() { document.querySelectorAll('.enrich-line').forEach(el => { const l = this.line(); el.textContent = l; el.classList.toggle('hidden', !l); }); },
  async run() {
    if (this.active || !Drive.token() || !navigator.onLine) { if (!Drive.token() && this.pending().length) { this.paused = true; this.showLine(); } return; }
    const queue = this.pending();
    if (!queue.length) { this.paused = false; this.showLine(); return; }
    this.active = true; this.paused = false; this.done = 0; this.total = queue.length; this.showLine();
    let stop = false;
    const worker = async () => {
      while (queue.length && !stop) {
        const t = queue.shift();
        if (!trackById(t.id)) continue;
        try {
          const tags = await readDriveTags(t);
          const base = tagsToTrack(tags, t.fileKey.startsWith('gdrive|') ? (t.origName || t.title) + '.x' : t.title);
          if (tags.title || tags.artist) Object.assign(t, { title: base.title, artist: base.artist });
          if (tags.album) t.album = base.album;
          if (tags.year) t.year = base.year;
          if (tags.track) t.track = base.track;
          if (tags.picture && tags.picture.data && tags.picture.data.length) {
            await DB.put('art', t.id, new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format || 'image/jpeg' }));
            t.hasArt = true; artCache.delete(t.id);
          }
        } catch (e) {
          if (e.message === 'gdrive-auth') { stop = true; queue.unshift(t); this.paused = true; break; }
        }
        t.tagged = true;
        await DB.put('tracks', t.id, t).catch(() => { });
        this.done++;
        this.showLine();
        if (this.done % 40 === 0 && Date.now() - this.lastRender > 8000) { this.lastRender = Date.now(); this.refresh(); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    this.active = false;
    this.showLine();
    this.refresh();
    if (!this.paused) { const moved = await carryOver(); if (moved) toast(`Likes and playlists carried over for ${moved} song${moved === 1 ? '' : 's'}`, 3000); }
  },
  refresh() {
    if (document.hidden || document.activeElement?.matches('input,textarea') || $('#sheet').classList.contains('on')) return;
    rerenderKeepScroll(); updatePlayerUI();
  },
};
let scanning = false;
async function driveScan(quiet = false) {
  const g = S.settings.gdrive;
  if (!g || !g.folderId || scanning) return;
  if (!Drive.token()) { if (!quiet) driveAuthSheet('scan'); return; }
  scanning = true;
  let added = 0, removed = 0;
  try {
    if (!quiet) toast(`Looking in "${g.folderName}"…`, 0);
    const files = await Drive.listAudio(g.folderId, n => { if (!quiet) toast(`Found ${n} songs…`, 0); });
    const existing = new Map(S.tracks.filter(t => t.source === 'gdrive').map(t => [t.driveId, t]));
    const ids = new Set(files.map(f => f.id));
    for (const t of existing.values()) if (!ids.has(t.driveId)) { await deleteTrack(t.id); removed++; }
    for (const f of files) { const t = existing.get(f.id); if (t && (t.folderName || null) !== (f.folderName || null)) { t.folderName = f.folderName || null; await DB.put('tracks', t.id, t); } }
    const hidden = new Set(g.hidden || []);
    const todo = files.filter(f => !existing.has(f.id) && !hidden.has(f.id));
    if (todo.length) {
      const now = Date.now(), fresh = [];
      todo.forEach((f, i) => fresh.push(Object.assign(tagsToTrack({}, f.name), { origName: f.name.replace(/\.[^.]+$/, ''),
        id: 'g' + uid(), folderName: f.folderName || null, duration: 0, addedAt: now + i, hasArt: false, source: 'gdrive',
        driveId: f.id, size: +f.size || 0, mime: f.mimeType || '', fileKey: 'gdrive|' + f.id, offline: false, tagged: false,
      })));
      for (let i = 0; i < fresh.length; i += 200) await DB.putMany('tracks', fresh.slice(i, i + 200).map(t => [t.id, t]));
      S.tracks.push(...fresh); added = fresh.length;
    }
    g.lastScan = Date.now(); await saveKV.settings();
    let moved = 0;
    if (added) { moved = await carryOver(); Sync.soon(1000); }
    Enrich.run();
    if (!quiet || added || removed) toast(added || removed ? `Google Drive: ${added} added${removed ? `, ${removed} removed` : ''}${added ? '. Ready to play while song details load' : ''}${moved ? `. Likes and playlists carried over for ${moved} song${moved === 1 ? '' : 's'}` : ''}` : 'Google Drive is up to date', added ? 4000 : 3000);
  } catch (e) {
    if (quiet) { if (added) toast(`Google Drive: ${added} added`, 2500); }
    else if (e.message === 'gdrive-auth') { toast('', 1); driveAuthSheet('scan'); }
    else toast("Couldn't finish reading Google Drive. Check your internet and try Scan again.", 3500);
  } finally { scanning = false; if (!quiet || added || removed) rerenderKeepScroll(); }
}
async function saveOffline(t) {
  if (!t || t.source !== 'gdrive') return;
  if (!Drive.token()) return driveAuthSheet('play');
  toast('Saving for offline…', 0);
  try {
    const b = await Drive.songBlob(t);
    await DB.put('blobs', t.id, b);
    t.offline = true; await DB.put('tracks', t.id, t);
    toast('Available offline'); requestPersist(); rerenderKeepScroll();
  } catch (e) {
    if (e.message === 'gdrive-auth') driveAuthSheet('play'); else toast("Couldn't save. Check your internet.", 3000);
  }
}
async function removeOffline(t) {
  if (!t) return;
  await DB.del('blobs', t.id);
  t.offline = false; await DB.put('tracks', t.id, t);
  toast('Removed from this phone. It still plays from Drive.', 2500); rerenderKeepScroll();
}
async function saveListOffline(items) {
  const list = items.map(p => p.type === 'song' && trackById(p.id)).filter(t => t && t.source === 'gdrive' && !t.offline);
  if (!list.length) { toast('Already available offline'); return; }
  if (!Drive.token()) return driveAuthSheet('play');
  for (let i = 0; i < list.length; i++) {
    toast(`Saving offline ${i + 1} of ${list.length}`, 0);
    try { const b = await Drive.fileBlob(list[i].driveId); await DB.put('blobs', list[i].id, b); list[i].offline = true; await DB.put('tracks', list[i].id, list[i]); }
    catch (e) { if (e.message === 'gdrive-auth') { driveAuthSheet('play'); return; } }
  }
  toast(`Saved ${list.length} song${list.length === 1 ? '' : 's'} for offline`, 2500); requestPersist(); rerenderKeepScroll();
}

/* ---------- listening history and stats ---------- */
const songKeyOf = t => t ? (t.driveId ? 'd:' + t.driveId : t.remoteKey ? 'r:' + t.remoteKey : 'f:' + (t.fileKey || t.id)) : null;
function pKey(p) {
  if (!p) return null;
  if (p.type === 'song') return songKeyOf(trackById(p.id));
  if (p.type === 'remote') return 'r:' + p.key;
  return null;
}
const monthKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const Stats = {
  cur: null, lastT: null, saveT: null,
  onTime() {
    const p = Player.cur, k = pKey(p);
    if (!k || audio.paused) { this.lastT = null; return; }
    if (!this.cur || this.cur.key !== k || this.cur.loadId !== Player.loadId) { this.cur = { key: k, secs: 0, counted: false, loadId: Player.loadId }; this.lastT = null; }
    const t = audio.currentTime;
    if (this.lastT != null) {
      const d = t - this.lastT;
      if (d > 0 && d < 3) {
        this.cur.secs += d;
        const m = monthKey();
        const st = S.stats[m] = S.stats[m] || { songs: {}, artists: {}, secs: 0 };
        st.secs += d;
        if (!this.cur.counted && (this.cur.secs >= 30 || (isFinite(audio.duration) && audio.duration > 0 && this.cur.secs >= audio.duration * 0.5))) {
          this.cur.counted = true;
          const pl = S.plays[k] = S.plays[k] || { n: 0, last: 0 };
          pl.n++; pl.last = Date.now(); pl.title = p.title; pl.artist = p.artist || p.sub || '';
          st.songs[k] = (st.songs[k] || 0) + 1;
          const a = p.artist || p.sub || 'Unknown artist';
          st.artists[a] = (st.artists[a] || 0) + 1;
          Sync.soon();
        }
        this.save();
      }
    }
    this.lastT = t;
  },
  save() { clearTimeout(this.saveT); this.saveT = setTimeout(() => { KV.set('plays', S.plays); KV.set('stats', S.stats); }, 2000); },
  totalPlays() {
    const out = {};
    const add = src => {
      for (const [k, v] of Object.entries(src || {})) {
        const o = out[k] = out[k] || { n: 0, last: 0, title: v.title, artist: v.artist };
        o.n += v.n || 0; o.last = Math.max(o.last, v.last || 0);
        if (!o.title) { o.title = v.title; o.artist = v.artist; }
      }
    };
    add(S.plays); for (const d of Object.values(S.others || {})) add(d.plays);
    return out;
  },
  month(m) {
    const out = { songs: {}, artists: {}, secs: 0 };
    const add = st => {
      if (!st) return;
      out.secs += st.secs || 0;
      for (const [k, v] of Object.entries(st.songs || {})) out.songs[k] = (out.songs[k] || 0) + v;
      for (const [k, v] of Object.entries(st.artists || {})) out.artists[k] = (out.artists[k] || 0) + v;
    };
    if (m === 'year') { const y = String(new Date().getFullYear()); for (const mm of this.months().filter(x => x.startsWith(y))) { const r = this.month(mm); add(r); } return out; }
    add(S.stats[m]); for (const d of Object.values(S.others || {})) add((d.stats || {})[m]);
    return out;
  },
  months() {
    const set = new Set(Object.keys(S.stats));
    for (const d of Object.values(S.others || {})) Object.keys(d.stats || {}).forEach(m => set.add(m));
    return [...set].sort().reverse();
  },
};

/* ---------- sync between phones ---------- */
const DEVICE_ID = (() => { try { let id = localStorage.getItem('isai-device-id'); if (!id) { id = uid(); localStorage.setItem('isai-device-id', id); } return id; } catch { return 'dev'; } })();
const podStub = p => ({ id: p.id, feedUrl: p.feedUrl, itunesId: p.itunesId, title: p.title, author: p.author, art: p.art });
function saveMeta() { return KV.set('meta', S.meta); }
function touch(kind, key, on, extra) {
  if (!key) return;
  const m = S.meta[kind] = S.meta[kind] || {};
  m[key] = Object.assign({ on, at: Date.now() }, extra || {});
  saveMeta(); Sync.soon();
}
function plTouch(pl) { pl.updatedAt = Date.now(); Sync.soon(); }
const keyMap = () => { const m = new Map(); for (const t of S.tracks) m.set(songKeyOf(t), t.id); return m; };
function localDoc() {
  const liked = Object.assign({}, S.meta.liked || {});
  for (const id of S.liked) { const k = songKeyOf(trackById(id)); if (k && !liked[k]) liked[k] = { on: true, at: 1 }; }
  const playlists = {};
  for (const pl of S.playlists) {
    const keys = pl.ids.map(id => songKeyOf(trackById(id))).filter(Boolean);
    for (const k of pl.extraKeys || []) if (!keys.includes(k)) keys.push(k);
    playlists[pl.id] = { name: pl.name, keys, at: pl.updatedAt || pl.createdAt || 1, createdAt: pl.createdAt || 1 };
  }
  const radio = Object.assign({}, S.meta.radio || {});
  for (const r of S.radioFavs) if (!radio[r.key]) radio[r.key] = { on: true, at: 1, item: r };
  const pods = Object.assign({}, S.meta.pods || {});
  for (const p of S.podcasts) if (!pods[p.feedUrl]) pods[p.feedUrl] = { on: true, at: 1, pod: podStub(p) };
  const recent = S.recent.map(p => Object.assign({}, p, { at: p.at || 1, sk: p.sk || pKey(p) || p.key }));
  return {
    v: 1, liked, playlists, plDel: Object.assign({}, S.meta.plDel || {}), radio, pods, recent, recentClear: S.meta.recentClear || 0,
    devices: Object.assign({}, S.others || {}, { [DEVICE_ID]: { name: DeviceName.get(), plays: S.plays, stats: S.stats, at: Date.now() } }),
  };
}
function newer(a, b) { const out = Object.assign({}, a || {}); for (const [k, v] of Object.entries(b || {})) if (!out[k] || (v.at || 0) > (out[k].at || 0)) out[k] = v; return out; }
function mergeDocs(a, b) {
  const plDel = {};
  for (const src of [a.plDel, b.plDel]) for (const [k, v] of Object.entries(src || {})) plDel[k] = Math.max(plDel[k] || 0, v);
  const playlists = newer(a.playlists, b.playlists);
  for (const id of Object.keys(playlists)) if (plDel[id] && plDel[id] >= (playlists[id].at || 0)) delete playlists[id];
  const recentClear = Math.max(a.recentClear || 0, b.recentClear || 0);
  const rec = new Map();
  for (const p of [...(a.recent || []), ...(b.recent || [])]) {
    if ((p.at || 0) <= recentClear) continue;
    const k = p.sk || p.key;
    if (!rec.has(k) || (p.at || 0) > (rec.get(k).at || 0)) rec.set(k, p);
  }
  const devices = {};
  for (const src of [a.devices, b.devices]) for (const [k, v] of Object.entries(src || {})) if (!devices[k] || (v.at || 0) > (devices[k].at || 0)) devices[k] = v;
  return {
    v: 1, liked: newer(a.liked, b.liked), playlists, plDel, radio: newer(a.radio, b.radio), pods: newer(a.pods, b.pods),
    recent: [...rec.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 30), recentClear, devices,
  };
}
function stateSig() {
  return JSON.stringify([[...S.liked].sort(), S.playlists.map(p => [p.id, p.name, p.ids]), S.radioFavs.map(r => r.key), S.podcasts.map(p => p.feedUrl), S.recent.map(r => r.key), Object.keys(S.others || {})]);
}
async function applyDoc(doc) {
  S.meta.liked = doc.liked || {}; S.meta.radio = doc.radio || {}; S.meta.pods = doc.pods || {}; S.meta.plDel = doc.plDel || {}; S.meta.recentClear = doc.recentClear || 0;
  const km = keyMap();
  S.liked = new Set(Object.entries(S.meta.liked).filter(([, v]) => v.on).map(([k]) => km.get(k)).filter(Boolean));
  S.playlists = Object.entries(doc.playlists || {}).map(([id, v]) => ({
    id, name: v.name, createdAt: v.createdAt, updatedAt: v.at,
    ids: [...new Set((v.keys || []).map(k => km.get(k)).filter(Boolean))], extraKeys: (v.keys || []).filter(k => !km.has(k)),
  })).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  S.radioFavs = Object.values(S.meta.radio).filter(v => v.on && v.item).sort((x, y) => (y.at || 0) - (x.at || 0)).map(v => v.item);
  let podsChanged = false;
  for (const [feed, v] of Object.entries(S.meta.pods)) {
    const has = S.podcasts.find(p => p.feedUrl === feed);
    if (v.on && !has && v.pod) { S.podcasts.push(Object.assign({}, v.pod, { episodes: [], fetchedAt: 0 })); podsChanged = true; }
    if (!v.on && has) { S.podcasts = S.podcasts.filter(p => p.feedUrl !== feed); podsChanged = true; }
  }
  S.recent = (doc.recent || []).map(p => {
    if (p.type !== 'song') return p;
    const id = km.get(p.sk); if (!id) return null;
    return Object.assign(songP(trackById(id)), { at: p.at, sk: p.sk });
  }).filter(Boolean).slice(0, 20);
  S.others = {};
  for (const [k, v] of Object.entries(doc.devices || {})) if (k !== DEVICE_ID) S.others[k] = v;
  await Promise.all([saveKV.liked(), saveKV.playlists(), saveKV.radioFavs(), saveKV.recent(), saveKV.podcasts(), saveMeta(), KV.set('others', S.others)]);
  if (podsChanged) setTimeout(() => refreshPodcasts(false), 600);
}
const Sync = {
  t: null, busy: false, again: false, fileId: null, lastAt: 0, err: '',
  soon(ms = 4000) { clearTimeout(this.t); this.t = setTimeout(() => this.run(), ms); },
  state() {
    if (!Drive.connected()) return 'no-drive';
    if (!Drive.hasSyncScope()) return 'needs-permission';
    if (!Drive.token()) return 'paused';
    return 'on';
  },
  async find() {
    if (this.fileId) return this.fileId;
    const d = await Drive.api('files', { spaces: 'appDataFolder', q: "name='isai-sync.json' and trashed=false", fields: 'files(id,modifiedTime)', pageSize: '5' });
    this.fileId = (d.files && d.files[0] && d.files[0].id) || null;
    return this.fileId;
  },
  async run() {
    if (this.state() !== 'on' || !navigator.onLine) return false;
    if (this.busy) { this.again = true; return false; }
    this.busy = true;
    try {
      const id = await this.find();
      let remote = null;
      if (id) { try { remote = JSON.parse(await (await Drive.fileBlob(id)).text()); } catch (e) { if (e.message === 'gdrive-auth') throw e; remote = null; } }
      const before = stateSig();
      const merged = remote && remote.v === 1 ? mergeDocs(remote, localDoc()) : localDoc();
      await applyDoc(merged);
      const body = JSON.stringify(merged), tok = Drive.token();
      if (!tok) throw new Error('gdrive-auth');
      if (this.fileId) {
        const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(this.fileId)}?uploadType=media`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body });
        if (r.status === 404) this.fileId = null; else if (!r.ok) throw new Error('HTTP ' + r.status);
      }
      if (!this.fileId) {
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ name: 'isai-sync.json', parents: ['appDataFolder'] })], { type: 'application/json' }));
        fd.append('file', new Blob([body], { type: 'application/json' }));
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        this.fileId = (await r.json()).id;
      }
      this.lastAt = Date.now(); this.err = ''; KV.set('lastSync', this.lastAt);
      if (stateSig() !== before && !document.hidden && !document.activeElement?.matches('input,textarea')) rerenderKeepScroll();
      return true;
    } catch (e) {
      this.err = e.message === 'gdrive-auth' ? 'paused' : 'failed';
      return false;
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.soon(); }
    }
  },
};

/* ---------- carry over when the Drive account changes ---------- */
const normTxt = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function rememberDriveSongs() {
  // Called before switching accounts: remember each Drive song's title and artist so likes,
  // playlists, and stats can be moved to the same song in the new Drive.
  const legacy = S.meta.legacy = S.meta.legacy || {};
  for (const t of S.tracks) if (t.source === 'gdrive') legacy[songKeyOf(t)] = { title: t.title, artist: t.artist, at: Date.now() };
  await saveMeta();
}
async function forgetOldDrive() {
  await rememberDriveSongs();
  Drive.readyClear(); Sync.fileId = null;
  for (const tr of S.tracks.filter(x => x.source === 'gdrive')) await deleteTrack(tr.id);
}
async function carryOver() {
  const legacy = S.meta.legacy || {};
  const olds = Object.keys(legacy);
  if (!olds.length) return 0;
  const byTA = new Map(), byT = new Map();
  for (const t of S.tracks) if (t.source === 'gdrive') {
    byTA.set(normTxt(t.title) + '|' + normTxt(t.artist), t);
    const k = normTxt(t.title); byT.set(k, byT.has(k) ? null : t);
  }
  const map = {};
  for (const ok of olds) {
    const L = legacy[ok];
    const hit = byTA.get(normTxt(L.title) + '|' + normTxt(L.artist)) || byT.get(normTxt(L.title));
    if (hit) map[ok] = songKeyOf(hit);
  }
  const moved = Object.keys(map);
  if (!moved.length) return 0;
  // likes
  const liked = S.meta.liked = S.meta.liked || {};
  for (const ok of moved) if (liked[ok]) { const nk = map[ok]; if (!liked[nk] || (liked[ok].at || 0) > (liked[nk].at || 0)) liked[nk] = Object.assign({}, liked[ok]); }
  const km = keyMap();
  S.liked = new Set(Object.entries(liked).filter(([, v]) => v.on).map(([k]) => km.get(k)).filter(Boolean));
  // playlists
  for (const pl of S.playlists) {
    let changed = false;
    pl.extraKeys = (pl.extraKeys || []).filter(k => {
      if (!map[k]) return true;
      const id = km.get(map[k]); if (id && !pl.ids.includes(id)) pl.ids.push(id);
      changed = true; return false;
    });
    if (changed) pl.updatedAt = Date.now();
  }
  // play counts and monthly stats
  const moveCounts = obj => {
    for (const ok of moved) if (obj[ok]) {
      const nk = map[ok], o = obj[ok];
      if (typeof o === 'number') obj[nk] = (obj[nk] || 0) + o;
      else { const n = obj[nk] = obj[nk] || { n: 0, last: 0, title: o.title, artist: o.artist }; n.n += o.n || 0; n.last = Math.max(n.last || 0, o.last || 0); }
      delete obj[ok];
    }
  };
  moveCounts(S.plays);
  for (const m of Object.values(S.stats)) moveCounts(m.songs || {});
  for (const d of Object.values(S.others || {})) { moveCounts(d.plays || {}); for (const m of Object.values(d.stats || {})) moveCounts(m.songs || {}); }
  // recently played
  S.recent = S.recent.map(p => { if (p.type !== 'song' || !map[p.sk]) return p; const id = km.get(map[p.sk]); return id ? Object.assign(songP(trackById(id)), { at: p.at, sk: map[p.sk] }) : p; });
  for (const ok of moved) delete legacy[ok];
  await Promise.all([saveMeta(), saveKV.liked(), saveKV.playlists(), saveKV.recent(), KV.set('plays', S.plays), KV.set('stats', S.stats), KV.set('others', S.others)]);
  Sync.soon(1000);
  return moved.length;
}

/* ---------- backup and restore ---------- */
async function backupNow() {
  const g = S.settings.gdrive;
  const data = {
    app: 'isai', kind: 'backup', v: 1, made: new Date().toISOString(), doc: localDoc(), progress: S.progress,
    settings: { jamendo: S.settings.jamendo, relay: S.settings.relay, gdrive: g ? { email: g.email, folderId: g.folderId, folderName: g.folderName, hidden: g.hidden || [] } : null },
  };
  const name = `isai-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Isai backup' }); toast('Backup ready'); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  toast('Backup saved to your downloads', 2500);
}
async function restoreFrom(file) {
  let data = null;
  try { data = JSON.parse(await file.text()); } catch { }
  if (!data || data.app !== 'isai' || !data.doc || data.doc.v !== 1) { toast("That file isn't an Isai backup", 3000); return; }
  if (!confirm(`Restore the backup from ${new Date(data.made).toLocaleDateString()}? It's combined with what's on this phone. Nothing here gets deleted.`)) return;
  await applyDoc(mergeDocs(localDoc(), data.doc));
  for (const [k, v] of Object.entries(data.progress || {})) if (!S.progress[k] || (v.at || 0) > (S.progress[k].at || 0)) S.progress[k] = v;
  await saveKV.progress();
  const st = data.settings || {};
  if (!S.settings.relay && st.relay) S.settings.relay = st.relay;
  if (st.gdrive && S.settings.gdrive && S.settings.gdrive.email === st.gdrive.email && st.gdrive.hidden) S.settings.gdrive.hidden = [...new Set([...(S.settings.gdrive.hidden || []), ...st.gdrive.hidden])];
  await saveKV.settings();
  toast('Backup restored', 2500); Sync.soon(1000); rerenderKeepScroll();
}

/* ---------- app identity ---------- */
const ME = { id: 'captain', name: 'Isai' };
const LOGO_SVG = `<svg viewBox="0 0 100 100" width="48" height="48" aria-hidden="true"><rect width="100" height="100" rx="22" fill="#1e1e1e"/><path d="M18 50 Q26 30 34 50 T50 50 T66 50 T82 50" fill="none" stroke="#EF9F27" stroke-width="7" stroke-linecap="round"/><path d="M18 50 Q26 70 34 50" fill="none" stroke="#EF9F27" stroke-width="3" stroke-linecap="round" opacity="0.5"/></svg>`;

/* ---------- listen together ---------- */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function toB64(buf) { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); }
function fromB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
const Together = {
  clients: [], session: null, key: null, topic: '', myId: '', partnerClient: null, seen: new Set(),
  code: '', role: null, partner: null, offset: 0, controller: null,
  bt: null, hb: null, beat: null, watch: null, helloTimer: null, joinTimer: null, lastSeen: 0, missing: null, status: 'idle', err: '',
  isSilent() { return (audio.currentSrc || audio.src || '').startsWith('data:audio/wav'); },
  connected() { return this.status === 'connected' && !!this.partner && !!this.partnerClient; },
  makeCode() {
    const w = ['RAGA', 'TALA', 'VEENA', 'MALLI', 'KUYIL', 'ISAI', 'NILA', 'MAYIL', 'SWARA', 'KAVI'];
    const r = crypto.getRandomValues(new Uint8Array(6));
    return w[crypto.getRandomValues(new Uint8Array(1))[0] % w.length] + '-' + [...r].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
  },
  unlock() {
    if (Player.ready && audio.src && !this.isSilent()) return;
    try { audio.src = SILENT_WAV; const p = audio.play(); if (p) p.then(() => audio.pause()).catch(() => { }); } catch { }
  },
  async openRelay(code) {
    if (!window.mqtt || !window.crypto || !crypto.subtle) return false;
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    this.key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('isai-together-v2'), iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('isai-topic|' + code)));
    this.topic = 'isai/together/' + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
    this.myId = uid(); this.seen = new Set();
    const session = this.session = {};
    return new Promise(resolve => {
      let settled = false, failed = 0;
      const finish = ok => { if (!settled) { settled = true; resolve(ok); } };
      setTimeout(() => finish(this.clients.some(c => c.connected)), 10000);
      for (const url of RELAYS) {
        let c;
        try { c = mqtt.connect(url, { clientId: 'isai_' + uid(), clean: true, connectTimeout: 9000, reconnectPeriod: 3000, keepalive: 30, protocolVersion: 4 }); }
        catch { if (++failed === RELAYS.length) finish(false); continue; }
        this.clients.push(c);
        let tried = false;
        c.on('connect', () => { c.subscribe(this.topic, { qos: 0 }, () => finish(true)); });
        c.on('message', (topic, payload) => { if (this.session === session) this.onRaw(payload); });
        c.on('error', () => { if (!tried) { tried = true; if (++failed === RELAYS.length) finish(false); } });
      }
    });
  },
  async send(m) {
    const clients = this.clients, key = this.key, topic = this.topic, from = this.myId;
    if (!key || !clients.length) return;
    try {
      const body = new TextEncoder().encode(JSON.stringify(Object.assign({}, m, { _f: from, _id: uid() })));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body);
      const payload = JSON.stringify({ i: toB64(iv), c: toB64(ct) });
      for (const c of clients) if (c.connected) c.publish(topic, payload, { qos: 0 });
    } catch { }
  },
  async onRaw(payload) {
    let d;
    try {
      const w = JSON.parse(new TextDecoder().decode(payload));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.i) }, this.key, fromB64(w.c));
      d = JSON.parse(new TextDecoder().decode(pt));
    } catch { return; }
    if (!d || d._f === this.myId) return;
    if (this.seen.has(d._id)) return;
    this.seen.add(d._id); if (this.seen.size > 600) this.seen = new Set([...this.seen].slice(-300));
    if (d._to && d._to !== this.myId) return;
    if (this.partnerClient && d._f !== this.partnerClient) { if (d.t === 'hello') this.send({ t: 'busy', _to: d._f }); return; }
    this.lastSeen = Date.now();
    this.onData(d);
  },
  async host() {
    this.leave(true); this.unlock();
    this.role = 'host'; this.code = this.makeCode(); this.status = 'starting'; this.err = '';
    refreshTogether();
    const code = this.code;
    const ok = await this.openRelay(code);
    if (this.code !== code) return;
    if (!ok) { this.fail("Couldn't reach the Listen together service. Check your internet and try again."); return; }
    this.status = 'waiting'; refreshTogether();
  },
  async join(raw) {
    const m = String(raw || '').trim().toUpperCase().replace(/\s+/g, '').match(/^([A-Z]+)-?([2-9A-HJ-NP-Z]{6})$/);
    if (!m) { this.err = 'Enter the code exactly as shown, like RAGA-7KX2QM'; refreshTogether(); return; }
    const code = m[1] + '-' + m[2];
    this.leave(true); this.unlock();
    this.role = 'guest'; this.code = code; this.status = 'joining'; this.err = '';
    refreshTogether();
    const ok = await this.openRelay(code);
    if (this.code !== code) return;
    if (!ok) { this.fail("Couldn't reach the Listen together service. Check your internet and try again."); return; }
    this.send(this.helloMsg());
    this.helloTimer = setInterval(() => { if (!this.connected()) this.send(this.helloMsg()); else clearInterval(this.helloTimer); }, 2000);
    this.joinTimer = setTimeout(() => { if (this.status === 'joining') this.fail("Couldn't find that session. Check the code, and make sure the other phone has Isai open."); }, 25000);
  },
  onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      const first = !this.partner;
      if (first) { this.partnerClient = d._f; clearInterval(this.helloTimer); clearTimeout(this.joinTimer); }
      this.partnerId = d.id;
      this.partner = { name: String(d.name || 'Other phone').slice(0, 24) };
      if (!first) { updateTogetherBar(); refreshTogether(); }
      this.status = 'connected';
      if (first) {
        this.send(this.helloMsg());
        toast(`Listening with ${this.partner.name}`);
        this.syncClock();
        if (this.role === 'host') setTimeout(() => { if (Player.cur) this.broadcast(); }, 1200);
        clearInterval(this.hb); clearInterval(this.beat); clearInterval(this.watch);
        this.hb = setInterval(() => { if (this.connected() && this.controller === DeviceName.get() && !audio.paused) this.broadcast(); }, 4000);
        this.beat = setInterval(() => { if (this.connected()) this.send({ t: 'beat' }); }, 8000);
        this.watch = setInterval(() => { if (this.connected() && Date.now() - this.lastSeen > 45000) this.onClose(true); }, 5000);
      }
      refreshTogether();
    }
    else if (d.t === 'ping') this.send({ t: 'pong', a: d.a, b: Date.now() });
    else if (d.t === 'pong') this.onPong(d);
    else if (d.t === 'state') this.applyRemote(d);
    else if (d.t === 'qadd') this.onQueueAdd(d);
    else if (d.t === 'react') { floatHeart(); toast(`${this.partner ? this.partner.name : 'The other phone'} sent a heart`, 1800); }
    else if (d.t === 'busy') { if (!this.connected()) this.fail('That session already has two people.'); }
    else if (d.t === 'bye') this.onClose();
  },
  helloMsg() { return { t: 'hello', id: 'phone', name: DeviceName.get() }; },
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
    if (p.type === 'song') { const t = trackById(p.id); return { type: 'song', key: p.key, title: p.title, artist: p.artist, album: p.album, duration: p.duration, driveId: t && t.driveId }; }
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
  remoteQueue: [], qt: null,
  isFollower() { return this.connected() && !!this.controller && this.controller !== DeviceName.get(); },
  queueChanged() { if (!this.connected() || this.isFollower()) return; clearTimeout(this.qt); this.qt = setTimeout(() => this.broadcast(), 200); },
  requestAdd(p, next) {
    this.send({ t: 'qadd', item: this.wireItem(p), next: !!next });
    toast(next ? `Playing next on ${this.controller}` : `Added to the queue on ${this.controller}`, 2000);
  },
  onQueueAdd(d) {
    if (this.isFollower()) return;
    const it = this.resolve(d.item);
    const who = this.partner ? this.partner.name : 'The other phone';
    if (!it) { toast(`${who} added "${d.item && d.item.title}", but it isn't on this phone`, 3500); return; }
    if (!Player.cur) { Player.play([it], 0, 'Listening together'); return; }
    if (d.next) Player.queue.splice(Player.idx + 1, 0, it); else Player.queue.push(it);
    saveState(); toast(`${who} added "${it.title}"`, 2200); this.broadcast();
  },
  localEvent() {
    if (!this.connected() || this.isSilent() || audio.ended) return;
    clearTimeout(this.bt);
    this.bt = setTimeout(() => { if (!this.matchesApplied()) this.broadcast(); }, 250);
  },
  broadcast() {
    if (!this.connected() || this.isSilent()) return;
    const p = Player.cur;
    this.controller = DeviceName.get(); this.missing = null; this.lastApplied = null; this.lastStateAt = Date.now();
    const upcoming = Player.queue.slice(Player.idx + 1, Player.idx + 41).map(x => this.wireItem(x));
    this.send({ t: 'state', item: this.wireItem(p), upcoming, playing: !!p && !audio.paused, time: audio.currentTime || 0, at: Date.now(), by: DeviceName.get() });
    updateTogetherBar();
  },
  resolve(item) {
    if (!item) return null;
    if (item.type !== 'song') return item;
    if (item.driveId) { const d = S.tracks.find(x => x.driveId === item.driveId); if (d) return songP(d); }
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
    this.remoteQueue = Array.isArray(s.upcoming) ? s.upcoming : [];
    if (sheetKind === 'queue' && $('#sheet').classList.contains('on')) queueSheet();
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
  fail(msg) { this.leave(true); this.err = msg; refreshTogether(); toast(msg, 3500); },
  onClose(lost = false) {
    const name = this.partner && this.partner.name;
    this.leave(true);
    if (name) toast(lost ? `Lost connection to ${name}` : `${name} left the session`);
  },
  leave(silent = false) {
    if (!silent && this.connected()) this.send({ t: 'bye' });
    [this.hb, this.beat, this.watch, this.helloTimer].forEach(clearInterval); clearTimeout(this.bt); clearTimeout(this.joinTimer);
    const clients = this.clients;
    this.clients = []; this.session = null; this.partner = null; this.partnerClient = null; this.partnerId = null;
    this.controller = null; this.missing = null; this.lastApplied = null; this.lastStateAt = 0;
    this.status = 'idle'; this.role = null; this.code = '';
    setTimeout(() => clients.forEach(c => { try { c.end(true); } catch { } }), silent ? 0 : 400);
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
  bar.innerHTML = `<button class="tg-main" data-a="together">${`<span class="avatar tg-phone" style="width:26px;height:26px">${icon('phone', 'sm')}</span>`}<span class="tg-text"><b>With ${esc(who)}</b><span>${ctl}</span></span></button>
    <button class="iconbtn" data-a="tg-heart" aria-label="Send a heart"><span class="acc">${icon('heart-f', 'sm')}</span></button>`;
}
let sheetKind = '';
function togetherSheet() { sheetKind = 'together'; renderTogetherSheet(); }
function refreshTogether() { if (sheetKind === 'together' && $('#sheet').classList.contains('on')) renderTogetherSheet(); updateTogetherBar(); }
function renderTogetherSheet() {
  const T = Together;
  let h = `<div style="font-weight:700;font-size:18px;margin-bottom:4px">Listen together</div>`;
  if (T.connected()) {
    h += `<div class="sheet-head" style="border:0;margin-top:8px">${`<span class="avatar tg-phone" style="width:48px;height:48px">${icon('phone', 'sm')}</span>`}<div><div style="font-weight:600">Listening with ${esc(T.partner.name)}</div><div class="muted" style="font-size:13px">Play, pause, skip, and seek stay in sync on both phones.</div></div></div>
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
      <form data-f="tg-join" style="display:flex;gap:8px"><input id="tg-code" class="tg-input" placeholder="RAGA-7KX2QM" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go"><button class="btn ghost" type="submit">Join</button></form>
      ${T.err ? `<p style="color:var(--danger);font-size:13px;margin-top:10px">${esc(T.err)}</p>` : ''}
      <p class="dim" style="font-size:12px;margin-top:16px">Podcasts, radio, and Discover music play on both phones. Your own songs play only if both phones have the same song.</p>`;
  }
  openSheet(h);
}

/* ---------- boot ---------- */
function cleanupOldProfiles() {
  try {
    if (localStorage.getItem('isai-single-profile')) return;
    indexedDB.deleteDatabase('isai-donna');
    localStorage.removeItem('isai-gtoken-donna');
    localStorage.removeItem('isai-profiles');
    localStorage.setItem('isai-single-profile', '1');
  } catch { }
}
function showWelcome() {
  const el = $('#picker');
  el.classList.remove('hidden'); el.classList.add('welcome-splash');
  el.innerHTML = `<div class="pk-inner">${LOGO_SVG.replace('width="48" height="48"', 'width="84" height="84"')}<h1>Welcome to the world of Isai</h1></div>`;
  const hide = () => { el.classList.add('fade'); setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fade', 'welcome-splash'); el.innerHTML = ''; }, 350); };
  el.addEventListener('click', hide, { once: true });
  setTimeout(hide, 1600);
}
function boot() {
  handleDriveRedirect();
  cleanupOldProfiles();
  if (!drivePending) showWelcome();
  start();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || Player.cur && !audio.paused) return;
      reloaded = true; location.reload();
    });
  }
}
async function start() {
  DB.name = 'isai';
  try { await DB.open(); }
  catch { $('#view').innerHTML = emptyHTML('x', 'Storage unavailable', 'Isai needs browser storage. Turn off private browsing and try again.'); return; }
  const [tracks, liked, playlists, podcasts, progress, recent, radioFavs, epDl, settings, player] = await Promise.all(
    [DB.all('tracks'), KV.get('liked'), KV.get('playlists'), KV.get('podcasts'), KV.get('progress'), KV.get('recent'), KV.get('radioFavs'), KV.get('epDl'), KV.get('settings'), KV.get('player')]);
  S.tracks = tracks || []; S.liked = new Set(liked || []); S.playlists = playlists || []; S.podcasts = podcasts || [];
  S.progress = progress || {}; S.recent = recent || []; S.radioFavs = radioFavs || []; S.epDl = epDl || {};
  S.settings = Object.assign({ jamendo: DEFAULT_JAMENDO, relay: '' }, settings || {});
  const [plays, stats, meta, others, lastSync] = await Promise.all([KV.get('plays'), KV.get('stats'), KV.get('meta'), KV.get('others'), KV.get('lastSync')]);
  S.plays = plays || {}; S.stats = stats || {}; S.meta = meta || {}; S.others = others || {}; Sync.lastAt = lastSync || 0;
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
  if (drivePending) setTimeout(runDrivePending, 400);
  else if (S.settings.gdrive && S.settings.gdrive.folderId && navigator.onLine) setTimeout(async () => { await driveScan(true); Sync.run(); }, 2500);
  setInterval(() => { if (!document.hidden) Sync.run(); }, 120000);
  setTimeout(() => Enrich.run(), 4000);
  if (Drive.connected()) Drive.loadGIS();
  render();
  updatePlayerUI();
}
boot();
