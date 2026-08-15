# 保守方針

このProjectは、小さな製品範囲を維持しながら、Windows ARM64／x64で同じsourceと検証契約を使います。architectureごとの分岐を機能codeへ持ち込まず、配布工程だけで吸収します。

## 正本

- 公開製品契約: `docs/PRODUCT_CONTRACT.md`
- 対応環境: `docs/SUPPORT_MATRIX.md`
- architecture、PE machine、成果物名: `scripts/lib/windows-package.mjs`
- package設定: `electron-builder.yml`
- CI: `.github/workflows/ci.yml`

成果物名やarchitectureを追加・変更するときは、個別scriptへ文字列を複製せず、`windows-package.mjs`とそのunit testから変更します。

## 通常の変更

```powershell
npm ci
npm run guide:check
npm run verify
```

配布へ影響する変更は、対象architectureのpackage verifierも実行します。

```powershell
npm run package:win:arm64
npm run verify:package:arm64

npm run package:win:x64
npm run verify:package:x64
```

CIはARM64とx64を別runnerで実行します。一方だけの成功をWindows全体の合格とは扱いません。

## 依存更新

- `package-lock.json`を正とし、Releaseは`npm ci`から再現する。
- Electron、electron-builder、HTML parserなど保存／表示／package境界へ影響する更新は、機能変更と同じPRへ混ぜない。
- 更新前後で`npm audit --audit-level=high`、`npm run verify`、両architectureのCIを確認する。
- Electronの対応OSまたはarchitectureが変わった場合は、`SUPPORT_MATRIX.md`、README、Release notesを同時に更新する。
- support終了済みruntimeを警告回避目的で固定し続けない。更新不能なら、理由と影響をIssueへ残して次のReleaseを止める。

## Releaseと不具合対応

- security修正は最新Releaseを対象とする。
- 保存、asset、recovery、IPC、sandboxの変更は回帰testと独立reviewを必須にする。
- package不具合は、source build成功と実installer成功を分けて記録する。
- owner実機、CI、framework公式対応の3種類の証拠を混同しない。
- 自動公開は行わず、architecture別installer／portable／ZIPとchecksumを確認してからDraft Releaseを公開する。
