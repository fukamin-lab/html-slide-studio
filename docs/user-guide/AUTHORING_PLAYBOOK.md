# スクリーンショット付きHTML手順書の制作・更新手順

この手順書は、本文をMarkdown、見た目をCSS、画面証拠をPNGに分けて管理する。`index.html`は生成物なので直接編集しない。

## 1. 正本と生成物

| 種類 | 正本／役割 |
| --- | --- |
| 構成 | `guide.config.json`。タイトルと章順を管理する |
| 本文 | `content/*.md`。目的ごとの説明と手順を管理する |
| HTML骨格 | `template.html` |
| 共通配置 | `assets/guide-base.css` |
| デザイン | `assets/theme.css`、`assets/brand-mark.svg` |
| 実画面証拠 | `assets/01-start.png`〜`08-presenter-window.png` |
| 撮影証跡 | `assets/capture-manifest.json`。取得時刻、commit、版、SHA-256を記録する |
| 生成物 | `index.html`。上記の正本から再生成する |

画面を見ていない動作を「画面確認済み」と書かない。実装・自動テストだけで確認した内容と、物理機で未確認の内容を本文で区別する。

## 2. 最初に作る流れ

1. 読者、達成したい目的、主な操作フローを決める。
2. 個人情報を含まない合成fixtureを用意する。
3. `guide.config.json` に章を登録し、`content/*.md` を目的ごとに作る。
4. 実UIを必要な状態へ進め、スクリーンショットを取得する。
5. スクリーンショットを先に置き、その下で「どこを押すか」「次に何が出るか」を補足する。
6. HTMLを生成し、画像参照、目次、リンク、横スクロールを検査する。

このProjectでは、次の一括撮影が合成HTML、専用Electron profile、固定debug portを使う。個人ファイルや普段のElectron profileは使わない。

```powershell
npm install
npm run capture:guide
```

取得する画面は次の8状態である。

| 画像 | 状態 |
| --- | --- |
| `01-start.png` | HTMLを開く開始画面 |
| `02-editor.png` | 編集画面全体 |
| `03-slide-operations.png` | 追加・複製後のスライド一覧 |
| `04-text-edit.png` | テキストとノートの編集 |
| `05-check.png` | 発表前チェック |
| `06-save-complete.png` | 上書き保存完了 |
| `07-audience-mode.png` | 1画面の聴衆向け発表 |
| `08-presenter-window.png` | 発表者ウィンドウ |

1画面環境では、`07`は実アプリの1画面発表を撮る。`08`はproduction rendererとPresenter専用preloadをテスト用Electronホストで実描画して撮る。これは実UIの証拠だが、物理2画面への同時配置確認とは区別する。物理2画面が使える場合は、実際に開いたPresenterを優先して撮る。

撮影は全PNGを一時領域へ作ってから一括反映する。途中失敗時は直前の公開画像へ戻し、成功時だけ`capture-manifest.json`を更新する。

## 3. 文章を追加・修正する

既存の説明を直す場合は対応する`content/*.md`を編集する。新しい目的を追加する場合はMarkdownを1つ追加し、`guide.config.json`の`sections`へID、見出し、ファイル名を登録する。

通常のMarkdownに加えて、次のdirectiveを使う。

```markdown
::: screenshot
src: assets/02-editor.png
alt: 編集画面の全体説明
badge: 実画面確認済み
caption: **保存** は上部にあります。
:::

::: steps
1. 押す場所を書く。
2. 次に表示される状態を書く。
3. 完了の見分け方を書く。
:::

::: notice
**注意:** 保存は同じHTMLへの上書きです。
:::
```

生HTMLは使わない。画像は`assets/`配下、リンクは安全な相対リンクまたはHTTP(S)／メールだけを使う。各画像には内容が分かる`alt`と、何の状態かを示すcaptionを付ける。

## 4. HTMLを生成・検査する

```powershell
npm run guide:build
npm run guide:check
```

その後、`docs/user-guide/index.html`をブラウザで開き、次を確認する。

1. 目次から全章へ移動できる。
2. 画像切れ、文字化け、意図しない横スクロールがない。
3. デスクトップ幅と狭い幅の両方で本文を読める。
4. 画面名、ボタン名、完了表示が現行アプリと一致する。
5. `git diff --check`が成功し、意図した正本と生成物だけが変わっている。

## 5. 後から手順を増やす流れ

1. 追加したい利用目的を1つに絞る。
2. 既存画像で説明できなければ、`capture-user-guide.mjs`へそのUI状態と新しい連番画像を追加する。
3. 対応するMarkdownを追加または修正し、図を先、文章を後に置く。
4. `capture:guide`、`guide:build`、`guide:check`を順に実行する。
5. 実アプリまたはE2Eで主フローを照合する。

UIが変わった場合は、影響する画像、caption、手順、manifestを同じ変更で更新する。古い画像を残して新旧を混在させない。

## 6. デザインを差し替える

本文とデザインを分離し、通常は次だけを交換する。

| ファイル | 変更するもの |
| --- | --- |
| `assets/theme.css` | 色、書体、角丸、影、背景、強調表現 |
| `assets/brand-mark.svg` | サイドバー、ヘッダー、faviconのブランド画像 |
| `assets/guide-base.css` | 配置、レスポンシブ、印刷、アクセシビリティ。原則維持 |

現在の標準はNotion風の静かな情報設計である。余白、文字サイズ、細い罫線で階層を作り、色付き左罫線、過剰なカード、強い影、グラデーション、装飾バッジを増やさない。テーマを差し替えた後も、本文やスクリーンショットを変更せず成立する状態を保つ。

## 7. Codexから呼び出す

このProject内の更新は、次のように依頼できる。

```text
build-product-user-guideスキルを使って、このProjectの手順書を更新してください。
今回追加した「画像を差し替える」手順を、実UIのスクリーンショット付きで追加し、
capture:guide、guide:build、guide:checkまで実行してください。
```

新しいProjectへ導入する場合は、次のように依頼する。

```text
build-product-user-guideスキルを使って、このProjectに
Markdown正本のスクリーンショット付きHTML手順書を導入してください。
読者は初回利用者、主フローは「開く→編集→保存→発表」です。
合成データだけを使い、未確認事項を分けてください。
```

グローバルskillは正本確認、撮影、編集、生成、検証を順に進める司令塔とし、製品固有のselector、fixture、画面遷移は各Projectのcapture scriptに残す。これにより、同じskillで別製品へ展開しても製品固有ロジックが混ざらない。
