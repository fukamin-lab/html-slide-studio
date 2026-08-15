# Changelog

このプロジェクトの主な変更を記録します。形式は[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)を参考にし、バージョンは[Semantic Versioning](https://semver.org/lang/ja/)に従います。

## [Unreleased]

## [0.2.0] - 2026-08-15

### Added

- 表示中のslideを切り替えずに全slideを一括検査し、指摘から該当slideと要素へ移動できる発表前check
- Windows ARM64向け通常インストーラー。インストール後は展開済みpayloadを直接起動し、portable EXEの起動ごとの自己展開を回避
- Windows x64向けinstaller、portable EXE、ZIPとnative x64 CI job
- architecture定義、成果物名、PE検証、checksum生成を共通moduleへ集約し、ARM64／x64の配布工程を同じ契約で保守

### Fixed

- 正常な折返しや`overflow: visible`の字形領域を文字clippingと誤判定せず、実際に隠れる／scrollを要する文字だけを発表前checkで検出
- 入力HTMLの危険なURL方式と`srcdoc`を除去し、編集前DOMの復元値を入力attributeから分離
- Electron実体pathをpackage内の`dist`直下へ限定

## [0.1.0] - 2026-08-11

### Added

- 静的HTMLスライドの文字、画像、位置、サイズ、基本書式の編集
- スライドの追加、複製、並べ替え
- 安全な同一ファイルへの上書き保存と中断時の復旧
- 発表者ノートと発表前チェック
- 1画面／複数画面での発表モード
- レーザー、ペン、スライド一覧を備えた発表者画面
- 編集用コピーとして開く8枚の同梱デモ
- Windows ARM64向けportable EXEとZIP

[Unreleased]: https://github.com/fukamin-lab/html-slide-studio/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fukamin-lab/html-slide-studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fukamin-lab/html-slide-studio/releases/tag/v0.1.0
