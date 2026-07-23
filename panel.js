/* =========================================================================
 * Live Cartwall — 操作パネル
 * このウィンドウは音を鳴らしません。対象タブに「鳴らせ」と指示するだけです。
 * （パネルで直接鳴らすと、その音は画面共有に乗りません）
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const el = {
  rail: $('rail'),
  railLabel: $('railLabel'),
  btnReload: $('btnReload'),
  tabSelect: $('tabSelect'),
  btnRefresh: $('btnRefresh'),
  btnConnect: $('btnConnect'),
  connNote: $('connNote'),
  bayOutput: $('bayOutput'),
  outputStatus: $('outputStatus'),
  sourceSelect: $('sourceSelect'),
  btnAddSource: $('btnAddSource'),
  tabSources: $('tabSources'),
  sourceNote: $('sourceNote'),
  baySource: $('baySource'),
  sourceStatus: $('sourceStatus'),
  modeEdit: $('modeEdit'),
  modeOperate: $('modeOperate'),
  tileW: $('tileW'),
  tileWVal: $('tileWVal'),
  tileH: $('tileH'),
  tileHVal: $('tileHVal'),
  buttons: $('buttons'),
  empty: $('empty'),
  drop: $('drop'),
  fileInput: $('fileInput'),
  master: $('master'),
  masterVal: $('masterVal'),
  btnStopAll: $('btnStopAll')
};

const SIZE_WARN = 20 * 1024 * 1024; // 20MB

/** @type {Array<object>} */
let sounds = [];
let masterVolume = 1;
/* 全ボタン共通のタイルサイズ（px）。編集モードの2本のバーで調整する。 */
let tileWidth = 96;
let tileHeight = 72;
let targetTabId = null;
let playingIds = new Set();
/* 'edit' … タイル編集可（kebab・追加ドロップを表示） / 'operate' … タップ再生のみ */
let mode = 'edit';
/* ドラッグ中のタイルのID（編集モードの並び替え用）。未ドラッグ時は null */
let draggedId = null;

/* タブ音源（ライブ音声のルーティング）。ストリームは揮発的なので永続化しない。
 * 各要素: { sourceId, tabId, title, volume, connected } */
let tabSources = [];
let connectedSources = new Set();
/* ソース選択に出す候補タブ（LIST_TABS の結果から出力タブを除外） */
let availableTabs = [];

/* ---------- 種別のプリセット ----------
 * bgm : 空間を満たす音。ループし、フェードで出入りする。控えめな音量。
 * se  : 一撃。重ねがけ可。フェードなし、しっかり聴かせる音量。
 */
const PRESET = {
  bgm: { loop: true,  overlap: false, fadeIn: 1.5, fadeOut: 2.5, volume: 0.35 },
  se:  { loop: false, overlap: true,  fadeIn: 0,   fadeOut: 0,   volume: 0.85 }
};

/* ---------- ボタンの色 ----------
 * 色は種別（kind）から切り離し、ボタンごとに任意で持たせる（sound.color）。
 * 種別は挙動（PRESET）とバッジ表示だけに使う。
 */

/* 色未設定のボタンの初期値・不正値のフォールバック（従来の種別色を踏襲） */
const DEFAULT_COLOR = { bgm: '#6fa8b8', se: '#e8a33d' };

/* 色ピッカーに添えるプリセットスウォッチ */
const PRESET_COLORS = ['#e8a33d', '#6fa8b8', '#d8443c', '#7bb661', '#a98fd8', '#e88fb8', '#e8d24d', '#9c8f7d'];

/* タイルに常時出す種別バッジのラベル（色ではなく文字で種別を示す） */
const KIND_LABEL = { bgm: 'BGM', se: 'SE' };

/** '#rrggbb' なら正規化して返す。不正なら種別の既定色へフォールバック。 */
function normalizeColor(color, kind) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : (DEFAULT_COLOR[kind] ?? DEFAULT_COLOR.se);
}

/**
 * 背景色に載せる文字色を、相対輝度から明(#efe7da)/暗(#17130f)で選ぶ。
 * 任意色は明暗が不定なので、コントラスト比が高い方を採る。
 */
function contrastInk(hex) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return '#17130f';
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(parseInt(m[1], 16)) + 0.7152 * lin(parseInt(m[2], 16)) + 0.0722 * lin(parseInt(m[3], 16));
  const INK_LIGHT = 0.83, INK_DARK = 0.006; // #efe7da / #17130f の相対輝度
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast(L, INK_DARK) >= contrast(L, INK_LIGHT) ? '#17130f' : '#efe7da';
}

/** タイル要素にボタンの色と、その上に載る文字色を反映する。 */
function applyTileColor(tile, color, kind) {
  const c = normalizeColor(color, kind);
  tile.style.setProperty('--tile-color', c);
  tile.style.setProperty('--tile-ink', contrastInk(c));
}

/* ---------- ストレージ ---------- */

async function loadState() {
  const s = await chrome.storage.local.get(['sounds', 'masterVolume', 'targetTabId', 'mode', 'tileWidth', 'tileHeight']);
  sounds = s.sounds ?? [];
  masterVolume = s.masterVolume ?? 1;
  targetTabId = s.targetTabId ?? null;
  mode = s.mode === 'operate' ? 'operate' : 'edit';
  tileWidth = s.tileWidth ?? 96;
  tileHeight = s.tileHeight ?? 72;

  // 旧データ（color 未設定）は種別の既定色を補い、以後は永続化する
  let migrated = false;
  for (const snd of sounds) {
    const color = normalizeColor(snd.color, snd.kind);
    if (snd.color !== color) { snd.color = color; migrated = true; }
  }
  if (migrated) await chrome.storage.local.set({ sounds });
}

async function persistSounds({ reload = true } = {}) {
  await chrome.storage.local.set({ sounds });
  if (reload) await toTab({ type: 'RELOAD' });
  render();
}

/* ---------- 対象タブとの通信 ---------- */

function toTab(payload) {
  return chrome.runtime.sendMessage({ type: 'TO_TAB', payload });
}

/* ---------- タブ選択 ---------- */

function tabHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function refreshTabs() {
  const res = await chrome.runtime.sendMessage({ type: 'LIST_TABS' });
  if (!res?.ok) return;

  el.tabSelect.innerHTML = '';
  for (const t of res.tabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    opt.textContent = `${t.title.slice(0, 46)} — ${tabHost(t.url)}`;
    if (t.id === targetTabId) opt.selected = true;
    el.tabSelect.appendChild(opt);
  }

  if (res.tabs.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(開いているタブがありません)';
    opt.disabled = true;
    el.tabSelect.appendChild(opt);
  }

  // ソース候補（出力先タブは自己キャプチャ防止のため除外）
  availableTabs = res.tabs.filter((t) => t.id !== targetTabId);
  el.sourceSelect.innerHTML = '';
  for (const t of availableTabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    opt.textContent = `${t.title.slice(0, 46)} — ${tabHost(t.url)}`;
    el.sourceSelect.appendChild(opt);
  }
  if (availableTabs.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(取り込めるタブがありません)';
    opt.disabled = true;
    el.sourceSelect.appendChild(opt);
  }
}

async function connect() {
  const tabId = Number(el.tabSelect.value);
  if (!Number.isFinite(tabId)) return;

  setNote('接続しています…', '');
  const res = await chrome.runtime.sendMessage({ type: 'INJECT', tabId });

  if (res?.ok) {
    targetTabId = tabId;
    setNote('接続しました。このタブの中で音が鳴ります。', 'is-good');
    updateOutputStatus();
    poll();
  } else {
    setNote('このタブには接続できません（Chromeの設定ページやストアのページなど）。別のタブを選んでください。', 'is-bad');
  }
}

function setNote(text, cls) {
  el.connNote.textContent = text;
  el.connNote.className = `note ${cls}`.trim();
}

/* 折りたたみ見出しの要約（出力先タブの接続状態）を更新する */
function updateOutputStatus() {
  const connected = targetTabId != null;
  el.outputStatus.textContent = connected ? '接続中' : '未接続';
  el.outputStatus.className = `fold__status ${connected ? 'is-on' : 'is-off'}`;
}

/* ---------- タブ音源（ライブ音声のルーティング） ---------- */

function setSourceNote(text, cls) {
  el.sourceNote.textContent = text;
  el.sourceNote.className = `note ${cls}`.trim();
}

/* 折りたたみ見出しの要約（タブ音源の件数・状態）を更新する */
function updateSourceStatus() {
  const n = tabSources.length;
  const lost = tabSources.filter((s) => !connectedSources.has(s.sourceId)).length;
  if (n === 0) {
    el.sourceStatus.textContent = 'なし';
    el.sourceStatus.className = 'fold__status is-off';
  } else if (lost > 0) {
    el.sourceStatus.textContent = `${n}件 · 要再接続${lost}`;
    el.sourceStatus.className = 'fold__status is-warn';
  } else {
    el.sourceStatus.textContent = `${n}件`;
    el.sourceStatus.className = 'fold__status is-on';
  }
}

/** 選択中のソースタブを出力先タブへ取り込む */
async function addSource() {
  if (targetTabId == null) {
    setSourceNote('先に出力先タブへ接続してください。', 'is-bad');
    return;
  }
  const tabId = Number(el.sourceSelect.value);
  if (!Number.isFinite(tabId)) return;
  if (tabId === targetTabId) {
    setSourceNote('出力先タブ自身は取り込めません。', 'is-bad');
    return;
  }

  const tab = availableTabs.find((t) => t.id === tabId);
  const title = tab?.title || '(無題)';

  setSourceNote('取り込んでいます…', '');
  const res = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID', sourceTabId: tabId });
  if (!res?.ok) {
    setSourceNote(res?.error === 'NO_TAB'
      ? '出力先タブが未設定です。先に接続してください。'
      : 'このタブは取り込めませんでした。', 'is-bad');
    return;
  }

  const sourceId = crypto.randomUUID();
  const volume = 0.8;
  const add = await toTab({ type: 'ADD_TAB_SOURCE', sourceId, streamId: res.streamId, volume });
  if (!add?.ok) {
    setSourceNote('音声の取り込みに失敗しました。もう一度お試しください。', 'is-bad');
    return;
  }

  tabSources.push({ sourceId, tabId, title, volume, connected: true });
  connectedSources.add(sourceId);
  setSourceNote('取り込みました。出力先タブでのみ再生されます。', 'is-good');
  renderTabSources();
}

/** 切断された（要再接続）ソースを、同じタブから取り込み直す */
async function reconnectSource(src) {
  if (targetTabId == null) {
    setSourceNote('先に出力先タブへ接続してください。', 'is-bad');
    return;
  }
  setSourceNote('再接続しています…', '');
  const res = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID', sourceTabId: src.tabId });
  if (!res?.ok) {
    setSourceNote('タブが見つかりません。閉じられた可能性があります。', 'is-bad');
    return;
  }
  const add = await toTab({ type: 'ADD_TAB_SOURCE', sourceId: src.sourceId, streamId: res.streamId, volume: src.volume });
  if (!add?.ok) {
    setSourceNote('再接続に失敗しました。', 'is-bad');
    return;
  }
  src.connected = true;
  connectedSources.add(src.sourceId);
  setSourceNote('再接続しました。', 'is-good');
  renderTabSources();
}

/** ルーティングを解除してパネルの一覧からも消す */
async function removeSource(sourceId) {
  await toTab({ type: 'REMOVE_TAB_SOURCE', sourceId });
  tabSources = tabSources.filter((s) => s.sourceId !== sourceId);
  connectedSources.delete(sourceId);
  renderTabSources();
}

function renderTabSources() {
  el.tabSources.innerHTML = '';
  for (const src of tabSources) el.tabSources.appendChild(renderTabSource(src));
  updateSourceStatus();
}

function renderTabSource(src) {
  const connected = connectedSources.has(src.sourceId);

  const row = document.createElement('div');
  row.className = `tsrc__row${connected ? '' : ' is-lost'}`;
  row.dataset.id = src.sourceId;

  /* 1段目：接続状態 / タイトル / 解除 */
  const top = document.createElement('div');
  top.className = 'tsrc__top';

  const dot = document.createElement('span');
  dot.className = 'tsrc__dot';
  dot.title = connected ? '接続中' : '切断（要再接続）';

  const name = document.createElement('span');
  name.className = 'tsrc__name';
  name.textContent = src.title;
  name.title = src.title;

  const del = document.createElement('button');
  del.className = 'tsrc__x';
  del.type = 'button';
  del.textContent = '解除';
  del.title = 'ルーティングを解除';
  del.addEventListener('click', () => removeSource(src.sourceId));

  top.append(dot, name, del);
  row.appendChild(top);

  /* 2段目：音量、または要再接続 */
  const bottom = document.createElement('div');
  bottom.className = 'tsrc__row2';

  if (connected) {
    const tag = document.createElement('span');
    tag.className = 'lvl__tag';
    tag.textContent = 'VOL';

    const lvl = document.createElement('input');
    lvl.type = 'range';
    lvl.className = 'lvl';
    lvl.min = '0'; lvl.max = '1'; lvl.step = '0.01';
    lvl.value = String(src.volume);

    const num = document.createElement('output');
    num.className = 'lvl__num';
    num.textContent = String(Math.round(src.volume * 100));

    lvl.addEventListener('input', () => {
      src.volume = Number(lvl.value);
      num.textContent = String(Math.round(src.volume * 100));
      toTab({ type: 'SET_TAB_VOLUME', sourceId: src.sourceId, value: src.volume });
    });

    bottom.append(tag, lvl, num);
  } else {
    const lost = document.createElement('span');
    lost.className = 'tsrc__lost';
    lost.textContent = '要再接続';

    const re = document.createElement('button');
    re.className = 'tsrc__re';
    re.type = 'button';
    re.textContent = '再接続';
    re.addEventListener('click', () => reconnectSource(src));

    bottom.append(lost, re);
  }

  row.appendChild(bottom);
  return row;
}

/**
 * 接続状態の点灯だけを更新する。
 * ここで renderTabSources() を呼ぶと、ドラッグ中の音量スライダーが作り直されて
 * つまみが飛んでしまうため、状態が変わったときだけ作り直す。
 */
function paintTabSources(connectedNow) {
  let changed = false;
  for (const src of tabSources) {
    const now = connectedNow.has(src.sourceId);
    if (src.connected !== now) { src.connected = now; changed = true; }
  }
  connectedSources = connectedNow;
  if (changed) renderTabSources();
  else updateSourceStatus();
}

/* ---------- 音源の追加 ---------- */

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('読み込みに失敗しました'));
    r.readAsDataURL(file);
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      const d = Number.isFinite(a.duration) ? a.duration : 0;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    a.src = url;
  });
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(f.name));
  if (files.length === 0) {
    setNote('音声ファイルではないようです。mp3 / wav / m4a / ogg を選んでください。', 'is-bad');
    return;
  }

  for (const file of files) {
    if (file.size > SIZE_WARN) {
      setNote(`「${file.name}」は ${(file.size / 1048576).toFixed(0)}MB あります。読み込みに時間がかかる場合は、事前に圧縮しておくと安定します。`, '');
    }

    const [data, duration] = await Promise.all([readAsBase64(file), probeDuration(file)]);

    // 30秒以上ならBGM、それ未満は効果音とみなす（あとから切り替え可）
    const kind = duration >= 30 ? 'bgm' : 'se';
    const id = crypto.randomUUID();

    // 音源の実体は別キーに置く。設定値を変えるたびに数MBを書き直さないため。
    await chrome.storage.local.set({ ['audio:' + id]: data });

    sounds.push({
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      kind,
      color: DEFAULT_COLOR[kind],
      duration,
      ...PRESET[kind]
    });
  }

  await persistSounds();
}

/* ---------- 描画 ---------- */

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function render() {
  el.buttons.innerHTML = '';
  el.empty.classList.toggle('is-hidden', sounds.length > 0);

  for (const sound of sounds) {
    el.buttons.appendChild(renderTile(sound));
  }

  if (document.activeElement !== el.master) {
    el.master.value = String(masterVolume);
  }
  el.masterVal.textContent = String(Math.round(masterVolume * 100));
}

/**
 * 全ボタン共通のタイルサイズを CSS カスタムプロパティで反映する。
 * タイルは el.buttons の配下なので、ここに設定すれば各タイルへ継承される。
 * render() でタイルを作り直しても値は保持されるため、サイズ変更では再描画しない
 * （スライダー操作中の render() はつまみ飛びの原因になるため避ける）。
 */
function applyTileSize() {
  el.buttons.style.setProperty('--tile-w', tileWidth + 'px');
  el.buttons.style.setProperty('--tile-h', tileHeight + 'px');
  el.tileW.value = String(tileWidth);
  el.tileH.value = String(tileHeight);
  el.tileWVal.textContent = String(tileWidth);
  el.tileHVal.textContent = String(tileHeight);
}

/* 開いている全メニュー（ポップオーバー）を閉じる */
function closeAllMenus() {
  for (const m of el.buttons.querySelectorAll('.tile__menu.is-open')) {
    m.classList.remove('is-open');
  }
}

/* 並び替えのドロップ位置インジケータを消す */
function clearDropMarks() {
  for (const t of el.buttons.querySelectorAll('.drag-before, .drag-after')) {
    t.classList.remove('drag-before', 'drag-after');
  }
}

/* sounds 配列内で draggedId のタイルを targetId の前/後へ移動する */
function moveSound(draggedId, targetId, placeAfter) {
  if (draggedId === targetId) return;
  const from = sounds.findIndex((s) => s.id === draggedId);
  if (from < 0) return;
  const [item] = sounds.splice(from, 1);
  let to = sounds.findIndex((s) => s.id === targetId);
  if (to < 0) { sounds.splice(from, 0, item); return; }
  if (placeAfter) to += 1;
  sounds.splice(to, 0, item);
}

/**
 * cartwall のタイル1枚。タイル全体がタップで再生/停止する再生ボタン。
 * 編集モードでは隅の kebab から表示名/音量/種別/削除を操作するメニューを開く。
 */
function renderTile(sound) {
  const isPlaying = playingIds.has(sound.id);

  const tile = document.createElement('div');
  tile.className = `tile tile--${sound.kind}${isPlaying ? ' is-playing' : ''}`;
  tile.dataset.id = sound.id;
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  applyTileColor(tile, sound.color, sound.kind);

  /* タイルタップ：BGM(loop)は再生⇄停止トグル、効果音(overlap)は毎回再生 */
  const trigger = async () => {
    if (playingIds.has(sound.id) && sound.loop) {
      handleTabResult(await toTab({ type: 'STOP', id: sound.id }));
    } else {
      handleTabResult(await toTab({ type: 'PLAY', id: sound.id }));
    }
  };
  tile.addEventListener('click', trigger);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
  });

  /* 編集モードのみドラッグで並び替え可能にする */
  tile.draggable = mode === 'edit';
  tile.addEventListener('dragstart', (e) => {
    // メニュー内（入力欄など）からのドラッグはタイル移動にしない
    if (e.target.closest('.tile__menu')) { e.preventDefault(); return; }
    draggedId = sound.id;
    tile.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sound.id);
    closeAllMenus();
  });
  tile.addEventListener('dragend', () => {
    tile.classList.remove('is-dragging');
    draggedId = null;
    clearDropMarks();
  });
  tile.addEventListener('dragover', (e) => {
    if (draggedId == null || draggedId === sound.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tile.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    clearDropMarks();
    tile.classList.add(after ? 'drag-after' : 'drag-before');
  });
  tile.addEventListener('dragleave', () => {
    tile.classList.remove('drag-before', 'drag-after');
  });
  tile.addEventListener('drop', async (e) => {
    if (draggedId == null || draggedId === sound.id) return;
    e.preventDefault();
    const rect = tile.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const dragged = draggedId;
    draggedId = null;
    clearDropMarks();
    moveSound(dragged, sound.id, after);
    await persistSounds({ reload: false });
  });

  /* 種別バッジ（色ではなく文字で BGM / 効果音 を示す。両モードで常時表示） */
  const badge = document.createElement('span');
  badge.className = 'tile__badge';
  badge.textContent = KIND_LABEL[sound.kind] ?? sound.kind;
  badge.title = sound.kind === 'bgm' ? 'BGM' : '効果音';
  tile.appendChild(badge);

  /* 再生状態バッジ（▶）。表示/非表示は is-playing クラスに応じて CSS が制御する。 */
  const state = document.createElement('span');
  state.className = 'tile__state';
  state.textContent = '▶';
  state.title = '再生中';
  state.setAttribute('aria-label', '再生中');
  tile.appendChild(state);

  /* 表示名（主体） */
  const name = document.createElement('span');
  name.className = 'tile__name';
  name.textContent = sound.name;
  name.title = sound.name;
  tile.appendChild(name);

  /* 長さ（cartwall らしさ優先で最小限） */
  const dur = document.createElement('span');
  dur.className = 'tile__dur';
  dur.textContent = fmtDur(sound.duration);
  tile.appendChild(dur);

  /* 隅の kebab（編集モードのみ CSS で表示） */
  const kebab = document.createElement('button');
  kebab.className = 'tile__kebab';
  kebab.type = 'button';
  kebab.textContent = '⋮';
  kebab.title = '編集';
  kebab.setAttribute('aria-label', '編集メニュー');

  const menu = buildTileMenu(sound, name, tile);

  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('is-open');
    closeAllMenus();
    menu.classList.toggle('is-open', willOpen);
  });

  tile.append(kebab, menu);
  return tile;
}

/** kebab から開くポップオーバー。表示名変更・種別切替・色・音量・削除を収める。 */
function buildTileMenu(sound, nameEl, tile) {
  const menu = document.createElement('div');
  menu.className = 'tile__menu';
  /* メニュー内のクリックはタイルタップ（再生）や外側クリック（閉じる）へ波及させない */
  menu.addEventListener('click', (e) => e.stopPropagation());

  /* 表示名変更 */
  const rename = document.createElement('input');
  rename.type = 'text';
  rename.className = 'tile__rename';
  rename.value = sound.name;
  rename.placeholder = '表示名';
  rename.setAttribute('aria-label', '表示名');
  rename.addEventListener('input', () => {
    sound.name = rename.value;
    nameEl.textContent = sound.name;
    nameEl.title = sound.name;
  });
  rename.addEventListener('change', () => chrome.storage.local.set({ sounds }));
  menu.appendChild(rename);

  /* 種別切替 */
  const kind = document.createElement('div');
  kind.className = 'kind';
  for (const [key, label] of [['bgm', 'BGM'], ['se', '効果音']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `kind__opt${sound.kind === key ? ' is-on' : ''}`;
    b.textContent = label;
    b.addEventListener('click', async () => {
      if (sound.kind === key) return;
      Object.assign(sound, { kind: key }, PRESET[key]);
      await persistSounds();
    });
    kind.appendChild(b);
  }
  menu.appendChild(kind);

  /* 色（ボタンごとの任意色）：カラーピッカー＋プリセットスウォッチ */
  const colorRow = document.createElement('div');
  colorRow.className = 'tile__color';

  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'tile__colorpick';
  picker.value = normalizeColor(sound.color, sound.kind);
  picker.setAttribute('aria-label', 'ボタンの色');

  const swatches = document.createElement('div');
  swatches.className = 'tile__swatches';

  /* 色を反映する。persist=false は入力中のライブ反映（保存はしない）。 */
  const applyColor = (value, { persist }) => {
    sound.color = normalizeColor(value, sound.kind);
    picker.value = sound.color;
    applyTileColor(tile, sound.color, sound.kind);
    for (const sw of swatches.children) {
      sw.classList.toggle('is-on', sw.dataset.color === sound.color);
    }
    if (persist) chrome.storage.local.set({ sounds });
  };

  for (const preset of PRESET_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `tile__swatch${sound.color === preset ? ' is-on' : ''}`;
    sw.dataset.color = preset;
    sw.style.background = preset;
    sw.title = preset;
    sw.setAttribute('aria-label', `色 ${preset}`);
    sw.addEventListener('click', () => applyColor(preset, { persist: true }));
    swatches.appendChild(sw);
  }

  picker.addEventListener('input', () => applyColor(picker.value, { persist: false }));
  picker.addEventListener('change', () => applyColor(picker.value, { persist: true }));

  colorRow.append(picker, swatches);
  menu.appendChild(colorRow);

  /* 音量 */
  const vol = document.createElement('div');
  vol.className = 'tile__menurow';

  const tag = document.createElement('span');
  tag.className = 'lvl__tag';
  tag.textContent = 'VOL';

  const lvl = document.createElement('input');
  lvl.type = 'range';
  lvl.className = 'lvl';
  lvl.min = '0'; lvl.max = '1'; lvl.step = '0.01';
  lvl.value = String(sound.volume);

  const num = document.createElement('output');
  num.className = 'lvl__num';
  num.textContent = String(Math.round(sound.volume * 100));

  lvl.addEventListener('input', () => {
    sound.volume = Number(lvl.value);
    num.textContent = String(Math.round(sound.volume * 100));
    toTab({ type: 'SET_VOLUME', id: sound.id, value: sound.volume });
  });
  lvl.addEventListener('change', () => chrome.storage.local.set({ sounds }));

  vol.append(tag, lvl, num);
  menu.appendChild(vol);

  /* 削除 */
  const del = document.createElement('button');
  del.className = 'tile__del';
  del.type = 'button';
  del.textContent = 'このボタンを削除';
  del.addEventListener('click', async () => {
    await toTab({ type: 'STOP', id: sound.id });
    sounds = sounds.filter((s) => s.id !== sound.id);
    await chrome.storage.local.remove('audio:' + sound.id);
    await persistSounds();
  });
  menu.appendChild(del);

  return menu;
}

/* ---------- モード切替 ---------- */

function applyMode() {
  document.body.classList.toggle('is-operate', mode === 'operate');
  el.modeEdit.classList.toggle('is-on', mode === 'edit');
  el.modeOperate.classList.toggle('is-on', mode === 'operate');
  el.modeEdit.setAttribute('aria-pressed', String(mode === 'edit'));
  el.modeOperate.setAttribute('aria-pressed', String(mode === 'operate'));
  closeAllMenus();
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  chrome.storage.local.set({ mode });
  applyMode();
  render(); // タイルの draggable を新モードに合わせて張り替える
}

/* ---------- 状態ポーリング ---------- */

function handleTabResult(res) {
  if (!res) return;

  if (res.error === 'NO_TAB') {
    setRail('warn', '出力先タブが未設定');
    return;
  }
  if (res.error === 'NOT_INJECTED') {
    setRail('warn', 'タブに接続されていません');
    return;
  }
  if (res.ctxState === 'suspended') {
    setRail('warn', 'タブを一度クリックしてください');
    return;
  }

  playingIds = new Set(res.playing ?? []);
  setRail(playingIds.size > 0 ? 'live' : '', playingIds.size > 0 ? '再生中' : '待機中');
}

function setRail(state, label) {
  el.rail.classList.toggle('is-live', state === 'live');
  el.rail.classList.toggle('is-warn', state === 'warn');
  el.railLabel.textContent = label;
}

/**
 * 再生中の点灯だけを更新する。
 * ここで render() を呼ぶと、ドラッグ中の音量スライダーが作り直されて
 * つまみが飛んでしまうため、クラスの付け外しに留める。
 */
function paintLive() {
  for (const tile of el.buttons.children) {
    const sound = sounds.find((s) => s.id === tile.dataset.id);
    if (!sound) continue;

    tile.classList.toggle('is-playing', playingIds.has(sound.id));
  }
}

async function poll() {
  const res = await toTab({ type: 'PING' });
  handleTabResult(res);
  paintLive();
  // 出力タブが応答し tabSources を返したときだけ接続状態を反映。
  // 未接続・未注入時は全ソースを切断扱いにする。
  paintTabSources(new Set(res?.ok && res.tabSources ? res.tabSources : []));
}

/* ---------- イベント配線 ---------- */

el.modeEdit.addEventListener('click', () => setMode('edit'));
el.modeOperate.addEventListener('click', () => setMode('operate'));

/* メニュー外をクリックしたら開いているポップオーバーを閉じる */
document.addEventListener('click', (e) => {
  if (e.target.closest('.tile__menu') || e.target.closest('.tile__kebab')) return;
  closeAllMenus();
});

el.btnRefresh.addEventListener('click', refreshTabs);
el.btnConnect.addEventListener('click', connect);
el.btnAddSource.addEventListener('click', addSource);
el.btnReload.addEventListener('click', async () => {
  const res = await toTab({ type: 'RELOAD' });
  handleTabResult(res);
});

el.fileInput.addEventListener('change', async (e) => {
  await addFiles(e.target.files);
  e.target.value = '';
});

el.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.drop.classList.add('is-over');
});
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('is-over'));
el.drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.drop.classList.remove('is-over');
  await addFiles(e.dataTransfer.files);
});

el.master.addEventListener('input', () => {
  masterVolume = Number(el.master.value);
  el.masterVal.textContent = String(Math.round(masterVolume * 100));
  toTab({ type: 'SET_MASTER', value: masterVolume });
});
el.master.addEventListener('change', () => chrome.storage.local.set({ masterVolume }));

/* タイルサイズ調整（横幅・縦幅）。操作中は CSS 変数と値表示だけを更新し、
 * タイルの作り直し（render）はしない。確定時（change）にのみ永続化する。 */
el.tileW.addEventListener('input', () => {
  tileWidth = Number(el.tileW.value);
  el.buttons.style.setProperty('--tile-w', tileWidth + 'px');
  el.tileWVal.textContent = String(tileWidth);
});
el.tileW.addEventListener('change', () => chrome.storage.local.set({ tileWidth }));

el.tileH.addEventListener('input', () => {
  tileHeight = Number(el.tileH.value);
  el.buttons.style.setProperty('--tile-h', tileHeight + 'px');
  el.tileHVal.textContent = String(tileHeight);
});
el.tileH.addEventListener('change', () => chrome.storage.local.set({ tileHeight }));

el.btnStopAll.addEventListener('click', async () => {
  const res = await toTab({ type: 'STOP_ALL' });
  handleTabResult(res);
  paintLive();
  // 全停止はタブ音源のルーティングも解除する（出力から外れる）
  tabSources = [];
  connectedSources = new Set();
  renderTabSources();
});

/* ---------- 起動 ---------- */

(async function init() {
  await loadState();
  applyMode();
  render();
  applyTileSize();
  await refreshTabs();

  updateOutputStatus();
  updateSourceStatus();

  if (targetTabId != null) {
    setNote('前回の出力先タブを記憶しています。ページを開き直した場合は接続し直してください。', '');
  } else {
    // 未接続なら出力先タブの設定を開いておき、まず接続を促す
    el.bayOutput.open = true;
  }

  poll();
  setInterval(poll, 1000);
})();
