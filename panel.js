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
  cues: $('cues'),
  empty: $('empty'),
  drop: $('drop'),
  fileInput: $('fileInput'),
  master: $('master'),
  masterVal: $('masterVal'),
  btnStopAll: $('btnStopAll')
};

const MAX_SLOTS = 6;
const SIZE_WARN = 20 * 1024 * 1024; // 20MB

/** @type {Array<object>} */
let sounds = [];
let masterVolume = 1;
let targetTabId = null;
let playingIds = new Set();

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

async function refreshTabs() {
  const res = await chrome.runtime.sendMessage({ type: 'LIST_TABS' });
  if (!res?.ok) return;

  el.tabSelect.innerHTML = '';
  for (const t of res.tabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    const host = (() => { try { return new URL(t.url).hostname; } catch { return ''; } })();
    opt.textContent = `${t.title.slice(0, 46)} — ${host}`;
    if (t.id === targetTabId) opt.selected = true;
    el.tabSelect.appendChild(opt);
  }

  if (res.tabs.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(開いているタブがありません)';
    opt.disabled = true;
    el.tabSelect.appendChild(opt);
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

function nextSlot() {
  const used = new Set(sounds.map((s) => s.slot).filter(Boolean));
  for (let i = 1; i <= MAX_SLOTS; i++) if (!used.has(i)) return i;
  return null;
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
      slot: nextSlot(),
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

  /* 左レール：スロット番号 */
  const rail = document.createElement('div');
  rail.className = 'cue__rail';
  rail.innerHTML = `
    <span>${sound.slot ? 'Q' + sound.slot : '–'}</span>
    <span class="cue__railsub">${sound.kind === 'bgm' ? 'BED' : 'HIT'}</span>`;
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

  /* 3段目：音量 / スロット */
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

  const slot = document.createElement('select');
  slot.className = 'slot';
  slot.title = 'キーボードショートカットのスロット';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '–';
  slot.appendChild(none);
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `Q${i}`;
    if (sound.slot === i) o.selected = true;
    slot.appendChild(o);
  }
  slot.addEventListener('change', async () => {
    const v = slot.value ? Number(slot.value) : null;
    // 同じスロットを他が使っていたら外す（1スロット1音源）
    if (v) for (const s of sounds) if (s !== sound && s.slot === v) s.slot = null;
    sound.slot = v;
    await persistSounds({ reload: false });
  });

  row2.append(tag, lvl, num, slot);
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
}

/* ---------- イベント配線 ---------- */

el.btnRefresh.addEventListener('click', refreshTabs);
el.btnConnect.addEventListener('click', connect);
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
