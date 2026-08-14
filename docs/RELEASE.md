# Release process

リリースは、公開リポジトリのclean cloneとWindows ARM64端末から作成します。内部開発リポジトリの生成物をそのまま公開しません。

## 1. Source gate

内部正本のcleanなmainでallowlist snapshotを作り、表示された`targetRoot`だけを公開候補として使います。

```powershell
npm run public:source:check
```

次に、表示された公開候補pathへ移動してsnapshotのgateを実行します。候補pathはGit cloneではないため、ここで`public:source:check`を再実行しません。

```powershell
npm ci
npm audit --audit-level=high
npm run guide:check
npm run verify
```

公開リポジトリへ反映した後は、そのcommitの新しいclean cloneで`npm run public:source:check`を実行します。この公開clone側の検査が、origin、clean状態、ignored／untracked file不在、公開境界を確認します。

- CIがmainの同一commitで成功している
- `git status --short` が空である
- README、CHANGELOG、ライセンス、第三者表示が対象バージョンと一致する
- ARM64限定、未署名であることがRelease notesに明記されている

## 2. Package gate

```powershell
npm run package:win
npm run verify:package
npm run release:checksums
```

生成物:

- `release/HTML Slide Studio.exe`
- `release/HTML Slide Studio-<version>-arm64-win.zip`
- `release/SHA256SUMS.txt`

`verify:package` はunpacked payloadのPE machineがARM64 `0xAA64`であること、ライセンスと第三者表示の内容一致、Electron／Chromiumライセンス、app.asarの不要なnode_modules・内部参照不在、securityを弱める起動optionの拒否を検査します。さらにportable EXEをremote debuggingなしで実起動し、Windows accessibility経由でトップ画面から8枚デモを開けること、文字追加で未保存になること、終了キャンセル・再終了・破棄後の自然終了を確認します。

## 3. Human acceptance

- portable EXEをダブルクリックして起動する
- デモを開き、文字編集、スライド切替、上書き保存、再openを確認する
- 発表モードでレーザー、ペン、ノート、終了を確認する
- 可能なら物理2画面で投映画面と発表者画面の配置・終了後の復元を確認する
- Windowsの未署名警告とREADMEの案内が矛盾しないことを確認する

## 4. Draft release

GitHub Releaseは最初にDraftで作成します。EXE、ZIP、`SHA256SUMS.txt`を添付し、所有者が内容と実機受け入れ結果を確認してから公開します。タグやReleaseをCIから自動公開しません。
