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

function setNote(text, cls) {
  const n = $('note');
  n.textContent = text;
  n.className = `menu__note ${cls || ''}`.trim();
}

/*
 * 3ステップの案内で「次にやること」を1つに絞る。
 *  ステップ1: 再生タブ未設定 → 再生タブを決める
 *  ステップ2: 再生タブ設定済み・音声未設定 → 音声（音源タブ/音源ファイル）を用意
 *  ステップ3: 音声あり → 操作パネルで再生
 * ステップ2→3 は置き換えではなく追加表示（取り込みは残し、複数追加できる）。
 */
function render() {
  const connected = targetTabId != null;
  const isOutput = connected && cur && cur.id === targetTabId;
  const hasAudio = sources.length > 0 || soundCount > 0;

  // --- 再生タブ section ---
  // 再生タブは同時に1つ。設定後は不要になるため接続中はセクションごと隠す
  //（切断は操作パネルで行う）。未接続のときだけ「再生タブにする」を出す。
  $('secOutput').classList.toggle('is-hidden', connected);
  $('btnSetOutput').disabled = !(cur && isCapturable(cur.url));

  // --- 音源タブ section（取り込み） ---
  const srcStatus = $('srcStatus');
  srcStatus.textContent = sources.length ? `${sources.length}件` : 'なし';
  srcStatus.className = `menu__status ${sources.length ? 'is-on' : 'is-off'}`;

  // 取り込み可否：再生タブ設定済み & 現在タブが再生タブ自身でない & キャプチャ可能
  const canAdd = connected && cur && cur.id !== targetTabId && isCapturable(cur.url);
  $('btnAddSource').disabled = !canAdd;

  if (!connected) {
    setNote('', '');
  } else if (cur && !isCapturable(cur.url)) {
    setNote('このタブは取り込めません（Chromeの内部ページなど）。', '');
  } else {
    // 「今このタブを取り込む」動線が伝わるよう、webページのタブ上で押す旨を明記。
    setNote('webページの音声を再生したい場合は、webページを表示したタブ上で取り込むボタンを押してください。', '');
  }

  // --- 操作パネル section（音声ファイル追加 / 再生） ---
  // 音声未設定なら「開いて音声ファイルを追加」、あれば「操作パネルを開く（再生）」。
  $('btnOpenPanel').textContent = hasAudio ? '操作パネルを開く' : '操作パネルを開いて音声ファイルを追加';

  // --- 案内文とセクションの出し分け ---
  let stepMsg;
  if (!connected) {
    stepMsg = (cur && !isCapturable(cur.url))
      ? 'このタブは再生タブにできません。動画や資料などのタブで開き直してください'
      : 'まずは音声を再生する場所を決めましょう';
  } else if (!hasAudio) {
    stepMsg = '再生する音声を設定しましょう';
  } else {
    stepMsg = '音声を再生しましょう';
  }
  $('stepMsg').textContent = stepMsg;

  // ステップ1では音源タブ・操作パネルを隠し、選択肢を再生タブ設定だけに絞る。
  $('secSource').classList.toggle('is-hidden', !connected);
  $('secPanel').classList.toggle('is-hidden', !connected);
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
  await loadState();
  render();
  setNote(res?.ok
    ? 'このタブを再生タブにしました。'
    : 'このタブには接続できません（Chromeの設定ページやストアなど）。',
    res?.ok ? 'is-good' : 'is-bad');
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
