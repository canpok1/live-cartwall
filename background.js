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

// アイコンのクリックは default_popup（menu.html）が受けるため onClicked は使わない。
// 操作パネルはメニューの「操作パネルを開く」から OPEN_PANEL メッセージで開く。

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { panelWindowId } = await chrome.storage.local.get('panelWindowId');
  if (windowId === panelWindowId) {
    await chrome.storage.local.remove('panelWindowId');
    // パネル（再生ボタン卓）を閉じたら再生中の音は止める（リモコンが消えたのに
    // 音だけ鳴り続けるのを防ぐ）。ただしタブ音源のルーティングは残す
    //（音源はアイコンメニューから独立して管理するため）。targetTabId も残す。
    await sendToTab({ type: 'STOP_ALL', immediate: true, keepTabSources: true });
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

/* ---------- メニュー／パネルからのメッセージ中継 ----------
 * タブ音源の streamId は、アイコンメニュー（menu.js＝拡張ページ）が
 * chrome.tabCapture.getMediaStreamId で取得する。メニューを開いた瞬間に
 * 現在のタブへ activeTab が付与されるため、その場で発行できる。
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'OPEN_PANEL') {
        await openPanel();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'INJECT') {
        // 新しい出力先に切り替えるので、旧出力先向けのタブ音源メタは破棄する。
        await chrome.storage.local.set({ targetTabId: msg.tabId, targetTabTitle: msg.title ?? '', tabSources: [] });
        await inject(msg.tabId);
        // 注入直後に音源を読み込ませる
        sendResponse(await sendToTab({ type: 'RELOAD' }));
        return;
      }

      if (msg?.type === 'DISCONNECT') {
        // 出力先タブを切断。旧タブの再生を即停止しタブ音源も解除してから、
        // targetTabId とタブ音源メタをクリアする（旧タブに音を残さない）。
        await sendToTab({ type: 'STOP_ALL', immediate: true });
        await chrome.storage.local.remove(['targetTabId', 'targetTabTitle']);
        await chrome.storage.local.set({ tabSources: [] });
        sendResponse({ ok: true });
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
  if (tabId === targetTabId) {
    // 出力先タブが閉じられた。タブ音源メタも一緒に片付ける。
    await chrome.storage.local.remove(['targetTabId', 'targetTabTitle']);
    await chrome.storage.local.set({ tabSources: [] });
  }
});
