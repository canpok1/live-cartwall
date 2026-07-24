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
let sources = [];        // タブ音源メタ [{ sourceId, title, volume }]

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
  const s = await chrome.storage.local.get(['targetTabId', 'targetTabTitle', 'tabSources']);
  targetTabId = s.targetTabId ?? null;
  targetTabTitle = s.targetTabTitle ?? '';
  sources = Array.isArray(s.tabSources) ? s.tabSources : [];
}

function setNote(text, cls) {
  const n = $('note');
  n.textContent = text;
  n.className = `menu__note ${cls || ''}`.trim();
}

function render() {
  const connected = targetTabId != null;
  const isOutput = connected && cur && cur.id === targetTabId;

  $('curTab').textContent = cur ? (cur.title || '(無題)') : '(タブを取得できません)';

  const outStatus = $('outStatus');
  outStatus.textContent = connected ? (targetTabTitle ? `接続中 · ${targetTabTitle}` : '接続中') : '未接続';
  outStatus.className = `menu__status ${connected ? 'is-on' : 'is-off'}`;

  // 再生タブボタン：現在タブが再生タブなら「切断」、それ以外は「再生タブにする」
  const btnSet = $('btnSetOutput');
  const btnDisc = $('btnDisconnect');
  btnSet.classList.toggle('is-hidden', isOutput);
  btnDisc.classList.toggle('is-hidden', !isOutput);
  btnSet.disabled = !(cur && isCapturable(cur.url));

  const srcStatus = $('srcStatus');
  srcStatus.textContent = sources.length ? `${sources.length}件` : 'なし';
  srcStatus.className = `menu__status ${sources.length ? 'is-on' : 'is-off'}`;

  // 取り込み可否：再生タブ設定済み & 現在タブが再生タブ自身でない & キャプチャ可能
  const canAdd = connected && cur && cur.id !== targetTabId && isCapturable(cur.url);
  $('btnAddSource').disabled = !canAdd;

  if (!connected) {
    setNote('先に再生タブを設定してください。', '');
  } else if (isOutput) {
    setNote('このタブは再生タブです。音源にするなら別のタブでこのメニューを開いてください。', '');
  } else if (cur && !isCapturable(cur.url)) {
    setNote('このタブは取り込めません（Chromeの内部ページなど）。', '');
  } else {
    setNote('「このタブの音声を取り込む」で再生タブへ合流します。', '');
  }
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

$('btnDisconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  await loadState();
  render();
  setNote('再生タブを切断しました。', '');
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
