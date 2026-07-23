/* =========================================================================
 * Live Cartwall — service worker
 *  - 操作パネル（別ウィンドウ）の開閉
 *  - パネル → 対象タブ へのメッセージ中継
 *  - 対象タブが遷移したときの content script 再注入
 * ========================================================================= */

const PANEL_W = 460;
const PANEL_H = 760;

/* ---------- 操作パネルを開く ---------- */

async function openPanel() {
  const { panelWindowId } = await chrome.storage.local.get('panelWindowId');

  if (panelWindowId != null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true });
      return;
    } catch (_) { /* 既に閉じられている */ }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: PANEL_W,
    height: PANEL_H,
    focused: true
  });
  await chrome.storage.local.set({ panelWindowId: win.id });
}

chrome.action.onClicked.addListener(openPanel);

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { panelWindowId } = await chrome.storage.local.get('panelWindowId');
  if (windowId === panelWindowId) {
    await chrome.storage.local.remove('panelWindowId');
  }
});

/* ---------- 対象タブへの送信 ---------- */

async function sendToTab(payload) {
  const { targetTabId } = await chrome.storage.local.get('targetTabId');
  if (targetTabId == null) return { ok: false, error: 'NO_TAB' };

  try {
    const res = await chrome.tabs.sendMessage(targetTabId, payload);
    return res ?? { ok: false, error: 'NO_RESPONSE' };
  } catch (_) {
    return { ok: false, error: 'NOT_INJECTED' };
  }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['content.js']
  });
}

/* ---------- タブ音源のキャプチャ ID を発行 ----------
 * ソースタブ（他タブで鳴っている音声）を、出力タブが getUserMedia で
 * 受け取れるように、そのペア専用の streamId を発行する。
 * targetTabId  : 音を取り込む「ソースタブ」
 * consumerTabId: 音を受け取って再生する「出力タブ」
 */
function getStreamId(options) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(streamId);
    });
  });
}

/* ---------- パネルからのメッセージ中継 ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'INJECT') {
        await chrome.storage.local.set({ targetTabId: msg.tabId });
        await inject(msg.tabId);
        // 注入直後に音源を読み込ませる
        sendResponse(await sendToTab({ type: 'RELOAD' }));
        return;
      }

      if (msg?.type === 'LIST_TABS') {
        const tabs = await chrome.tabs.query({});
        const extUrl = chrome.runtime.getURL('');
        sendResponse({
          ok: true,
          tabs: tabs
            .filter((t) => t.url && !t.url.startsWith(extUrl) && !t.url.startsWith('chrome://'))
            .map((t) => ({
              id: t.id,
              title: t.title || '(無題)',
              url: t.url,
              favIconUrl: t.favIconUrl,
              audible: t.audible
            }))
        });
        return;
      }

      if (msg?.type === 'GET_STREAM_ID') {
        const { targetTabId } = await chrome.storage.local.get('targetTabId');
        if (targetTabId == null) { sendResponse({ ok: false, error: 'NO_TAB' }); return; }
        if (msg.sourceTabId === targetTabId) { sendResponse({ ok: false, error: 'SELF_CAPTURE' }); return; }
        try {
          const streamId = await getStreamId({
            targetTabId: msg.sourceTabId,
            consumerTabId: targetTabId
          });
          sendResponse({ ok: true, streamId });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      if (msg?.type === 'TO_TAB') {
        sendResponse(await sendToTab(msg.payload));
        return;
      }

      sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

/* ---------- 対象タブが遷移したら再注入 ----------
 * Googleスライドはプレゼン開始時にURLが /present に変わることがある。
 * 同じタブ内で遷移した場合はここで自動復帰する。
 * （別タブが開いた場合はパネルでタブを選び直す必要あり）
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const { targetTabId } = await chrome.storage.local.get('targetTabId');
  if (tabId !== targetTabId) return;
  try {
    await inject(tabId);
    await sendToTab({ type: 'RELOAD' });
  } catch (_) { /* 注入不可なページ */ }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { targetTabId } = await chrome.storage.local.get('targetTabId');
  if (tabId === targetTabId) await chrome.storage.local.remove('targetTabId');
});
