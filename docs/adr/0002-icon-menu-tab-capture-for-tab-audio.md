# 0002. タブ音源の取り込みをアイコンメニュー＋tabCaptureで行う

- ステータス: 採用
- 日付: 2026-07-24

## コンテキスト

[0001](0001-desktop-capture-for-tab-audio.md) で desktopCapture 方式を採用したが、返るストリームを出力タブの content script で `getUserMedia` 消費した瞬間にレンダラーがクラッシュした（`BadMessageReason::DESKTOP_CAPTURER_INVALID_OR_UNKNOWN_ID`）。desktopCapture のストリームは content script から安全に消費できない。一方、元の `tabCapture.getMediaStreamId` は取り込み対象タブに `activeTab` を要求し、別ウィンドウの操作パネルからは付与できず全タブで失敗していた（`activeTab` はそのタブで拡張を起動したときだけ付く）。加えて「ユーザー操作は操作パネルではなく拡張アイコンに寄せたい」という方針が決まった。

## 決定

拡張アクションを `default_popup`（menu.html）にし、「今見ているタブ」へ役割を割り当てるメニューにする。メニューを開くと現在タブに `activeTab` が付くため、その場で `tabCapture.getMediaStreamId(targetTabId=現在タブ, consumerTabId=再生タブ)` を発行できる。再生タブの設定/切断と音源の取り込みはメニュー、取り込み済み音源の音量調整/解除は操作パネルが担い、両者は `storage.tabSources` で状態を共有する。消費経路は従来どおり content script の `chromeMediaSource:'tab'`（クラッシュしない）。

## 結果

- 良い影響: `activeTab` 問題を設計として解消し、任意タブを安定して取り込める。desktopCapture 方式のクラッシュも起きない。操作パネルは再生ボタン卓に純化。権限は `desktopCapture` を外し `tabCapture` へ戻すため増えない。
- トレードオフ: 取り込みは対象タブごとに「アイコン→メニュー→取り込む」の操作が要る。切断された音源の再接続も同様にメニューから行う（パネルからは activeTab を得られない）。パネルを閉じても音源ルーティングは維持する（再生ボタンの音のみ停止）。

## 検討した代替案

- desktopCapture を継続し、ストリームをページの main world で消費してクラッシュ回避: ページの main world を汚し音声ルーティングを全面書き直す必要があり、動作保証も乏しいため不採用。
- 右クリックメニューやショートカットで `activeTab` を得る: 実現可能だが「操作を拡張アイコンに集約する」方針と合わず、アイコンメニューに一本化した。
