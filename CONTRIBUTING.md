# Contributing

HTML Slide Studioへの関心をありがとうございます。不具合報告、再現手順、焦点の合った改善提案を歓迎します。

## このプロジェクトの焦点

このアプリは、AIなどで作成済みの静的HTMLスライドをWindows上で最後に直し、そのまま発表するための小さなツールです。汎用オフィススイート、クラウド共同編集、PowerPoint変換を目指していません。

提案するときは、次の3点をIssueへ書いてください。

1. 誰が、どの場面で困っているか
2. 現在どう回避しているか
3. 変更によって既存の単純さや安全性がどう変わるか

## 開発手順

Node.js 22以降とWindowsを使います。

```powershell
npm ci
npm run guide:check
npm run verify
```

配布物に関わる変更では、対象architectureで次も実行してください。CIはARM64／x64の両方を別runnerで検証します。

```powershell
npm run package:win:arm64
npm run verify:package:arm64

npm run package:win:x64
npm run verify:package:x64
```

## Pull Request

- 変更目的を一つに絞ってください。
- 関係のない整形や依存更新を混ぜないでください。
- UI変更には、変更前後が分かる画像と実機確認内容を添えてください。
- 保存、ファイル操作、Electron IPC、発表画面の変更には回帰テストを追加してください。
- ユーザー向け挙動を変えた場合はREADME、ユーザーガイド、Product Contractも更新してください。

コントリビューションは、プロジェクトと同じMIT Licenseで提供されるものとして扱います。

## 行動

相手の背景や経験にかかわらず、具体的で敬意ある会話をお願いします。人格ではなく、再現手順、利用者影響、コード、テストを議論してください。嫌がらせ、差別、個人情報の公開は受け入れません。
