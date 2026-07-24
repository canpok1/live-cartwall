# 0001. タブ音源のキャプチャを desktopCapture 方式にする

- ステータス: 置換（[0002](0002-icon-menu-tab-capture-for-tab-audio.md) により撤回）
- 日付: 2026-07-24

## コンテキスト

タブ音源機能は `chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId })` で、パネルのドロップダウンから選んだソースタブを出力先タブへルーティングしていた。しかし `getMediaStreamId` は対象タブに `activeTab` 権限を要求し、`activeTab` は「そのタブで拡張アイコンをクリックして起動したとき」だけ付与される。別ウィンドウのパネルから選ぶ他タブには付与されないため、取り込みは常に `Extension has not been invoked for the current page (see activeTab permission)` で失敗していた。「他タブの音声を取り込めない」のは構造的制約で、機能追加当初から潜在していた。

## 決定

`chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], 出力先タブ, cb)` を採用する。出力先タブを `targetTab` に指定することで、返る `streamId` を出力先タブのコンテンツスクリプトが `getUserMedia({ chromeMediaSource: 'desktop' })` で消費できる（既存の「出力先タブの AudioContext へ合流させる」構成を維持）。あわせて manifest の権限を `tabCapture` から `desktopCapture` へ置換し、不要になった `GET_STREAM_ID` 中継を削除する。

## 結果

- 良い影響: `activeTab` 制約を回避し、パネルに居たまま任意のタブ音声を取り込める。再生経路（出力先タブへの合流）は変更不要。権限は置換のみで増えない。
- トレードオフ: 取り込みのたびに Chrome 標準の共有ピッカーが表示される。ピッカーは選ばれたタブを拡張へ返さないため、ソース名は自動採番（「共有音源 N」）となり、再接続もピッカーで選び直す。desktopCapture はソースタブをミュートしないため、操作者の手元では音が二重に聞こえる場合がある。ピッカーで出力先タブ自体を選ぶとフィードバックの恐れがある（利用者の選択に委ねる）。

## 検討した代替案

- アイコン起動方式（tabCapture 維持）: 取り込みたいタブで拡張アイコンをクリックして `activeTab` を付与し、その場で `getMediaStreamId` する。権限追加は不要だが、ソースタブごとに主ウィンドウへ切り替えてクリックする必要があり、パネル中心の操作感が崩れるため却下。
- 現状維持: 他タブを取り込めないため不可。
