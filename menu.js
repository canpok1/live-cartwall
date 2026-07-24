/* =========================================================================
 * Live Cartwall — アイコンメニュー（action popup）
 *
 * 「今見ているタブ」に役割を割り当てる小さなメニュー。
 *  - このタブを再生タブ（出力先）にする / 切断する
 *  - このタブの音声を取り込む（音源タブにする）
 *  - 操作パネル（再生ボタン卓）を開く
 *
 * 重要: chrome.tabCapture.getMediaStreamId は「取り込む対象タブに activeTab が
 * 付与されていること＋ユーザー操作」を要求する。拡張アイコンでこのメニューを
 * 開いた瞬間、現在のタブに activeTab が付くので、その場で streamId を発行できる。
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

let cur = null;          // 現在のタブ {id, title, url}
let targetTabId = null;  // 再生タブ（出力先）
let targetTabTitle = '';
let sources = [];        // 音源タブ（取り込み）メタ [{ sourceId, title, volume }]
let soundCount = 0;      // 音源ファイル（再生ボタン）の数

/** キャプチャ・注入ができないタブ（Chrome内部ページ・ストア等）を弾く */
function isCapturable(url) {
  if (!url) return false;
  if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url)) return false;
  if (/^https:\/\/chrome\.google\.com\/webstore/i.test(url)) return false;
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return false;
  return true;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function loadState() {
  const s = await chrome.storage.local.get(['targetTabId', 'targetTabTitle', 'tabSources', 'sounds']);
  targetTabId = s.targetTabId ?? null;
  targetTabTitle = s.targetTabTitle ?? '';
  sources = Array.isArray(s.tabSources) ? s.tabSources : [];
  soundCount = Array.isArray(s.sounds) ? s.sounds.length : 0;
}

/* 説明文（#desc）に一時メッセージを出す。cls は is-good / is-bad。 */
function setNote(text, cls) {
  const d = $('desc');
  d.textContent = text;
  d.className = `menu__desc ${cls || ''}`.trim();
}

/*
 * 各ステップを「見出し → 説明文 → ボタン」の縦流れで表示する。
 *  ステップ1: 再生タブ未設定 → 再生タブを決める
 *  ステップ2: 再生タブ設定済み・音声未設定 → 音声（音源タブ/音声ファイル）を用意
 *  ステップ3: 音声あり → 操作パネルで再生
 * ステップ2→3 は置き換えではなく追加表示（取り込みは残し、複数追加できる）。
 */
function render() {
  const connected = targetTabId != null;
  const isOutput = connected && cur && cur.id === targetTabId;
  const hasAudio = sources.length > 0 || soundCount > 0;
  const capturable = Boolean(cur && isCapturable(cur.url));

  // --- ボタンの表示・活性 ---
  // 再生タブは同時に1つ。設定後は不要なので接続中は「再生タブにする」を隠す
  //（切断は操作パネルで行う）。取り込み・操作パネルは接続中のみ表示する。
  $('btnSetOutput').classList.toggle('is-hidden', connected);
  $('btnSetOutput').disabled = !capturable;

  $('btnAddSource').classList.toggle('is-hidden', !connected);
  // 取り込み可否：再生タブ設定済み & 現在タブが再生タブ自身でない & キャプチャ可能
  $('btnAddSource').disabled = !(connected && cur && cur.id !== targetTabId && capturable);

  $('btnOpenPanel').classList.toggle('is-hidden', !connected);
  $('btnOpenPanel').textContent = hasAudio ? '操作パネルを開く' : '操作パネルを開いて音声ファイルを追加';

  // --- 見出しと説明文 ---
  let title, desc;
  if (!connected) {
    title = 'まずは音声を再生する場所を決めましょう';
    desc = capturable
      ? '音声はここで選んだタブの中で再生されます。共有するスライドや配信画面のタブで、下のボタンを押してください。'
      : 'このタブ（Chromeの内部ページなど）は再生タブにできません。動画や資料などのタブで開き直してください。';
  } else if (!hasAudio) {
    title = '再生する音声を設定しましょう';
    desc = sourceStepDesc(isOutput, capturable);
  } else {
    title = '音声を再生しましょう';
    desc = '操作パネルの再生ボタンで音を鳴らせます。音声を足すときは、webページはそのタブで取り込み、音声ファイルは操作パネルから追加します。';
  }
  $('stepMsg').textContent = title;
  const d = $('desc');
  d.textContent = desc;
  d.className = 'menu__desc'; // 直前の is-good/is-bad 着色をリセット
}

/* ステップ2（再生タブ設定済み・音声未設定）の説明文。現在タブの状態で出し分ける。 */
function sourceStepDesc(isOutput, capturable) {
  if (isOutput) {
    // 現在タブ＝再生タブ自身なので取り込みボタンが押せない。理由と次の行動を示す。
    return 'いま開いているこのタブは再生タブ自身なので、音声は取り込めません。webページの音声はそのタブでこのメニューを開いて取り込み、音声ファイルは操作パネルから追加します。';
  }
  if (!capturable) {
    return 'このタブは取り込めません（Chromeの内部ページなど）。webページの音声はそのタブでメニューを開いて取り込み、音声ファイルは操作パネルから追加します。';
  }
  return '「このタブの音声を取り込む」で、このタブの音声を再生タブへ流せます。効果音などの音声ファイルは操作パネルから追加できます。';
}

/** tabCapture.getMediaStreamId を Promise 化。lastError は reject する。 */
function getStreamId(options) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(streamId);
    });
  });
}

/* ---------- 操作 ---------- */

$('btnSetOutput').addEventListener('click', async () => {
  if (!cur) return;
  setNote('接続しています…', '');
  const res = await chrome.runtime.sendMessage({ type: 'INJECT', tabId: cur.id, title: cur.title || '' });
  if (!res?.ok) {
    setNote('このタブには接続できません（Chromeの設定ページやストアなど）。', 'is-bad');
    return;
  }
  // 成功時は render() が状態に応じた案内（＝次にやること）を表示する
  await loadState();
  render();
});

$('btnAddSource').addEventListener('click', async () => {
  if (targetTabId == null || !cur || cur.id === targetTabId) return;

  // ユーザー操作＋activeTab が要るので、まず getStreamId を呼ぶ（他の await より先）。
  let streamId;
  try {
    streamId = await getStreamId({ targetTabId: cur.id, consumerTabId: targetTabId });
  } catch (e) {
    setNote(`取り込めませんでした。（詳細: ${String(e)}）`, 'is-bad');
    return;
  }

  const sourceId = crypto.randomUUID();
  const volume = 0.8;
  const title = cur.title || '(無題)';

  const add = await chrome.runtime.sendMessage({
    type: 'TO_TAB',
    payload: { type: 'ADD_TAB_SOURCE', sourceId, streamId, volume }
  });
  if (!add?.ok) {
    setNote(`音声の取り込みに失敗しました。（詳細: ${add?.error ?? '不明'}）`, 'is-bad');
    return;
  }

  sources = [...sources, { sourceId, title, volume }];
  await chrome.storage.local.set({ tabSources: sources });
  render();
  setNote(`「${title}」を取り込みました。音量・解除は操作パネルで調整できます。`, 'is-good');
});

$('btnOpenPanel').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
  window.close();
});

/* ---------- 起動 ---------- */

(async function init() {
  cur = await getCurrentTab();
  await loadState();
  render();
})();
