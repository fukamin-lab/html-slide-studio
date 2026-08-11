# Release process

リリースは、公開リポジトリのclean cloneとWindows ARM64端末から作成します。内部開発リポジトリの生成物をそのまま公開しません。

## 1. Source gate

```powershell
npm run public:check
npm ci
npm audit --audit-level=high
npm run guide:check
npm run verify
```

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

`verify:package` はunpacked payloadのPE machineがARM64 `0xAA64`であること、ライセンスと第三者表示の内容一致、Electron／Chromiumライセンス、app.asarの不要なnode_modules・内部参照不在、portable EXEの実起動、トップ画面からの8枚デモopen、preload bridge、未保存状態での終了キャンセル・再終了・破棄後の自然終了を検査します。

## 3. Human acceptance

- portable EXEをダブルクリックして起動する
- デモを開き、文字編集、スライド切替、上書き保存、再openを確認する
- 発表モードでレーザー、ペン、ノート、終了を確認する
- 可能なら物理2画面で投映画面と発表者画面の配置・終了後の復元を確認する
- Windowsの未署名警告とREADMEの案内が矛盾しないことを確認する

## 4. Draft release

GitHub Releaseは最初にDraftで作成します。EXE、ZIP、`SHA256SUMS.txt`を添付し、所有者が内容と実機受け入れ結果を確認してから公開します。タグやReleaseをCIから自動公開しません。
