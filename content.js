/* =========================================================================
 * Live Cartwall — content script (音声エンジン)
 *
 * このスクリプトは「画面共有するタブ」の中で動きます。
 * ここで鳴らした音はタブの音声としてMeetの「タブの音声も共有」に乗ります。
 * 操作パネル（別ウィンドウ）からのメッセージを受けて再生/停止するだけの係。
 * ========================================================================= */

(() => {
  // 多重注入ガード（executeScript が複数回走っても状態を壊さない）
  if (window.__LIVE_CARTWALL__) return;
  window.__LIVE_CARTWALL__ = true;

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  /** @type {Map<string, AudioBuffer>} */
  const buffers = new Map();
  /** @type {Map<string, object>} 音源メタ（音量・ループ・フェード等） */
  const meta = new Map();
  /** @type {Map<string, Set<{src:AudioBufferSourceNode, gain:GainNode}>>} 再生中ノード */
  const active = new Map();
  /** @type {Map<string, {stream:MediaStream, srcNode:MediaStreamAudioSourceNode, gain:GainNode}>} タブ音源（ルーティング中のライブ音声） */
  const tabSources = new Map();

  /* ---------------------------------------------------------------------
   * 自動再生ポリシー対策
   * タブ内で一度もユーザー操作がないと AudioContext は suspended のまま。
   * ページ上のクリック/キー操作（＝ユーザー操作）を拾って resume する。
   * Googleスライドは矢印キーでめくるので、進行中は自然に解除される。
   *
   * 重要：resume()/start() を suspended のまま呼ぶと、たとえ Promise を
   * catch してもブラウザが「AudioContext was not allowed to start」警告を
   * コンソールに出す（JS では握りつぶせない）。そこで resume は必ず
   * ユーザー操作ハンドラの中だけで行い、未解除中に来た再生要求は捨てずに
   * pendingPlays へ積んでおき、解除された瞬間（onstatechange）に流す。
   * ------------------------------------------------------------------- */
  /** @type {Set<string>} suspended中に要求され、解除後に再生する音のID */
  const pendingPlays = new Set();

  const unlock = () => {
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  // ユーザー操作で running になったら、保留していた再生要求をまとめて流す。
  ctx.onstatechange = () => {
    if (ctx.state !== 'running' || pendingPlays.size === 0) return;
    const ids = [...pendingPlays];
    pendingPlays.clear();
    for (const id of ids) play(id);
  };

  /* --------------------------------------------------------------------- */

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function status() {
    const playing = [];
    for (const [id, set] of active) if (set.size > 0) playing.push(id);
    return {
      ok: true,
      ctxState: ctx.state,          // 'running' | 'suspended'
      loaded: [...buffers.keys()],
      playing,
      tabSources: [...tabSources.keys()],   // 接続中のタブ音源 sourceId
      href: location.href,
      title: document.title
    };
  }

  /** chrome.storage.local から音源を読み込み、まだデコードしていないものだけデコード */
  async function loadSounds() {
    const { sounds = [], masterVolume = 1 } =
      await chrome.storage.local.get(['sounds', 'masterVolume']);

    master.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.01);

    const ids = new Set(sounds.map((s) => s.id));

    // 削除された音源を破棄（鳴っていれば止めてから）
    for (const id of [...meta.keys()]) {
      if (ids.has(id)) continue;
      stop(id, 0);
      buffers.delete(id);
      active.delete(id);
      meta.delete(id);
    }

    // 追加された音源をデコード（実体は audio:<id> に別置き）
    const missing = sounds.filter((s) => !buffers.has(s.id));
    if (missing.length > 0) {
      const keys = missing.map((s) => 'audio:' + s.id);
      const blobs = await chrome.storage.local.get(keys);

      for (const s of missing) {
        const b64 = blobs['audio:' + s.id];
        if (!b64) continue;
        try {
          const buf = await ctx.decodeAudioData(base64ToArrayBuffer(b64));
          buffers.set(s.id, buf);
        } catch (e) {
          console.error('[LiveCartwall] デコード失敗:', s.name, e);
        }
      }
    }

    for (const s of sounds) meta.set(s.id, s);

    // 再生中の音に新しい音量を反映
    for (const [id, set] of active) {
      const m = meta.get(id);
      if (!m) continue;
      for (const node of set) {
        node.gain.gain.setTargetAtTime(m.volume ?? 0.8, ctx.currentTime, 0.02);
      }
    }

    return status();
  }

  function play(id) {
    const buf = buffers.get(id);
    if (!buf) return { ok: false, error: 'NOT_LOADED' };

    const m = meta.get(id) || {};

    // 未解除（suspended）なら start() で自動再生ポリシー警告が出る。ここでは
    // 鳴らさず保留し、タブ操作で解除された時に onstatechange が流す。
    // パネルには suspended を返し「タブを一度クリック」を促す。
    if (ctx.state !== 'running') {
      pendingPlays.add(id);
      return status();
    }

    // 重ねがけを許可しない音（BGM等）は、先に鳴っている同じ音を止める
    if (!m.overlap) stop(id, 0.06);

    const now = ctx.currentTime;
    const vol = Math.max(0.0001, m.volume ?? 0.8);
    const fadeIn = m.fadeIn ?? 0;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = !!m.loop;

    const gain = ctx.createGain();
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, now + fadeIn);
    } else {
      gain.gain.setValueAtTime(vol, now);
    }

    src.connect(gain);
    gain.connect(master);
    src.start(now);

    const node = { src, gain };
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(node);
    src.onended = () => active.get(id)?.delete(node);

    return status();
  }

  function stop(id, fadeOverride) {
    pendingPlays.delete(id); // 未解除で保留中の再生要求も取り消す
    const set = active.get(id);
    if (!set || set.size === 0) return status();

    const m = meta.get(id) || {};
    const fade = fadeOverride !== undefined ? fadeOverride : (m.fadeOut ?? 0);
    const now = ctx.currentTime;

    for (const node of [...set]) {
      try {
        if (fade > 0) {
          const cur = Math.max(0.0001, node.gain.gain.value);
          node.gain.gain.cancelScheduledValues(now);
          node.gain.gain.setValueAtTime(cur, now);
          node.gain.gain.exponentialRampToValueAtTime(0.0001, now + fade);
          node.src.stop(now + fade + 0.03);
        } else {
          node.src.stop(now);
        }
      } catch (_) { /* 既に停止済み */ }
      set.delete(node);
    }
    return status();
  }

  function stopAll(immediate) {
    pendingPlays.clear(); // 保留中の再生要求も破棄する
    for (const id of [...active.keys()]) stop(id, immediate ? 0 : undefined);
    // タブ音源も出力から外す（ソースタブ自体はタブ側で鳴り続ける）
    removeAllTabSources();
    return status();
  }

  function setVolume(id, value) {
    const m = meta.get(id);
    if (m) m.volume = value;
    const set = active.get(id);
    if (set) {
      for (const node of set) {
        node.gain.gain.setTargetAtTime(Math.max(0.0001, value), ctx.currentTime, 0.02);
      }
    }
    return status();
  }

  function setMaster(value) {
    master.gain.setTargetAtTime(Math.max(0.0001, value), ctx.currentTime, 0.02);
    return status();
  }

  /* ---------------------------------------------------------------------
   * タブ音源（他タブのライブ音声）のルーティング
   * ソースタブの音声を streamId 経由で受け取り、個別 GainNode を挟んで
   * 既存の master に合流させる。これでファイル音源と同じマスター音量・
   * 全停止の系統に乗る。ソースごとに独立管理するので、1つの解除・切断が
   * 他のソースに影響しない。トランスポート（再生/停止/シーク）はソース
   * タブ側で行い、ここで扱うのは音量とルーティングの接続/解除のみ。
   * ------------------------------------------------------------------- */

  /** ノードを切り離して Map から除去（stream の停止は行わない） */
  function teardownTabSource(sourceId) {
    const e = tabSources.get(sourceId);
    if (!e) return;
    try { e.srcNode.disconnect(); } catch (_) {}
    try { e.gain.disconnect(); } catch (_) {}
    tabSources.delete(sourceId);
  }

  async function addTabSource(sourceId, streamId, volume) {
    // 同じ sourceId が残っていれば作り直す（再接続）
    removeTabSource(sourceId);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });
    } catch (e) {
      console.error('[LiveCartwall] タブ音源の取得に失敗:', e);
      return { ok: false, error: 'CAPTURE_FAILED' };
    }

    // ライブ音声は running になれば流れる。suspended のまま resume() すると
    // 警告が出るため、ここでは resume しない（タブ操作での解除に委ねる）。
    const srcNode = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0.0001, volume ?? 1);
    srcNode.connect(gain);
    gain.connect(master);

    tabSources.set(sourceId, { stream, srcNode, gain });

    // ソースタブを閉じる/リロードするとトラックが終了する → 自動クリーンアップ
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => teardownTabSource(sourceId);

    return status();
  }

  function setTabVolume(sourceId, value) {
    const e = tabSources.get(sourceId);
    if (e) e.gain.gain.setTargetAtTime(Math.max(0.0001, value), ctx.currentTime, 0.02);
    return status();
  }

  /** ルーティングを解除する。track.stop() でソースタブのローカル音を復帰させる */
  function removeTabSource(sourceId) {
    const e = tabSources.get(sourceId);
    if (!e) return status();
    try { for (const t of e.stream.getTracks()) t.stop(); } catch (_) {}
    teardownTabSource(sourceId);
    return status();
  }

  function removeAllTabSources() {
    for (const id of [...tabSources.keys()]) removeTabSource(id);
  }

  /* --------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'PING':        sendResponse(status()); break;
          case 'RELOAD':      sendResponse(await loadSounds()); break;
          case 'PLAY':        sendResponse(play(msg.id)); break;
          case 'STOP':        sendResponse(stop(msg.id)); break;
          case 'STOP_ALL':    sendResponse(stopAll(msg.immediate)); break;
          case 'SET_VOLUME':  sendResponse(setVolume(msg.id, msg.value)); break;
          case 'SET_MASTER':  sendResponse(setMaster(msg.value)); break;
          case 'ADD_TAB_SOURCE':    sendResponse(await addTabSource(msg.sourceId, msg.streamId, msg.volume)); break;
          case 'SET_TAB_VOLUME':    sendResponse(setTabVolume(msg.sourceId, msg.value)); break;
          case 'REMOVE_TAB_SOURCE': sendResponse(removeTabSource(msg.sourceId)); break;
          case 'UNLOCK':      unlock(); sendResponse(status()); break;
          default:            sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // 非同期応答
  });

  // 注入直後に音源を復元（プレゼンモードでURLが変わって再注入されても復帰する）
  loadSounds();

  console.log('[LiveCartwall] 音声エンジンを注入しました。');
})();
