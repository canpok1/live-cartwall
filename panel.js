/* =========================================================================
 * Tab Audio Console — 操作パネル
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
  sourceSelect: $('sourceSelect'),
  btnAddSource: $('btnAddSource'),
  tabSources: $('tabSources'),
  sourceNote: $('sourceNote'),
  cues: $('cues'),
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
let targetTabId = null;
let playingIds = new Set();

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

/* ---------- ストレージ ---------- */

async function loadState() {
  const s = await chrome.storage.local.get(['sounds', 'masterVolume', 'targetTabId']);
  sounds = s.sounds ?? [];
  masterVolume = s.masterVolume ?? 1;
  targetTabId = s.targetTabId ?? null;
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
    poll();
  } else {
    setNote('このタブには接続できません（Chromeの設定ページやストアのページなど）。別のタブを選んでください。', 'is-bad');
  }
}

function setNote(text, cls) {
  el.connNote.textContent = text;
  el.connNote.className = `note ${cls}`.trim();
}

/* ---------- タブ音源（ライブ音声のルーティング） ---------- */

function setSourceNote(text, cls) {
  el.sourceNote.textContent = text;
  el.sourceNote.className = `note ${cls}`.trim();
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
  el.cues.innerHTML = '';
  el.empty.classList.toggle('is-hidden', sounds.length > 0);

  for (const sound of sounds) {
    el.cues.appendChild(renderCue(sound));
  }

  if (document.activeElement !== el.master) {
    el.master.value = String(masterVolume);
  }
  el.masterVal.textContent = String(Math.round(masterVolume * 100));
}

function renderCue(sound) {
  const isPlaying = playingIds.has(sound.id);

  const card = document.createElement('div');
  card.className = `cue cue--${sound.kind}${isPlaying ? ' is-playing' : ''}`;
  card.dataset.id = sound.id;

  /* 左レール：種別インジケータ。再生中に灯る */
  const rail = document.createElement('div');
  rail.className = 'cue__rail';
  rail.innerHTML = `<span>${sound.kind === 'bgm' ? 'BED' : 'HIT'}</span>`;
  card.appendChild(rail);

  const body = document.createElement('div');
  body.className = 'cue__body';

  /* 1段目：名前 / 長さ / 削除 */
  const top = document.createElement('div');
  top.className = 'cue__top';

  const name = document.createElement('span');
  name.className = 'cue__name';
  name.textContent = sound.name;
  name.title = sound.name;

  const dur = document.createElement('span');
  dur.className = 'cue__dur';
  dur.textContent = fmtDur(sound.duration);

  const del = document.createElement('button');
  del.className = 'cue__x';
  del.type = 'button';
  del.textContent = '×';
  del.title = '削除';
  del.addEventListener('click', async () => {
    await toTab({ type: 'STOP', id: sound.id });
    sounds = sounds.filter((s) => s.id !== sound.id);
    await chrome.storage.local.remove('audio:' + sound.id);
    await persistSounds();
  });

  top.append(name, dur, del);
  body.appendChild(top);

  /* 2段目：種別 / GO / STOP */
  const row1 = document.createElement('div');
  row1.className = 'cue__row';

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

  const go = document.createElement('button');
  go.className = 'go';
  go.type = 'button';
  go.textContent = isPlaying && sound.loop ? '再生中' : '再生';
  go.addEventListener('click', async () => {
    const res = await toTab({ type: 'PLAY', id: sound.id });
    handleTabResult(res);
  });

  const halt = document.createElement('button');
  halt.className = 'halt';
  halt.type = 'button';
  halt.textContent = '停止';
  halt.addEventListener('click', () => toTab({ type: 'STOP', id: sound.id }));

  row1.append(kind, go, halt);
  body.appendChild(row1);

  /* 3段目：音量 */
  const row2 = document.createElement('div');
  row2.className = 'cue__row';

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

  row2.append(tag, lvl, num);
  body.appendChild(row2);

  card.appendChild(body);
  return card;
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
  for (const card of el.cues.children) {
    const sound = sounds.find((s) => s.id === card.dataset.id);
    if (!sound) continue;

    const isPlaying = playingIds.has(sound.id);
    card.classList.toggle('is-playing', isPlaying);

    const go = card.querySelector('.go');
    if (go) go.textContent = isPlaying && sound.loop ? '再生中' : '再生';
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
  render();
  await refreshTabs();

  if (targetTabId != null) {
    setNote('前回の出力先タブを記憶しています。ページを開き直した場合は接続し直してください。', '');
  }

  poll();
  setInterval(poll, 1000);
})();
