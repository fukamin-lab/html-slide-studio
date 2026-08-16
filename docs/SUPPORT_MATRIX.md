# 対応環境

HTML Slide Studioは、Windows 10以降の64-bit環境を対象にします。Electronが公式binaryを提供するWindows `arm64`と`x64`を、architecture別のinstallerとして配布します。

| OS／CPU | 対応 | 自動検証 | 実機確認 |
| --- | --- | --- | --- |
| Windows 11 ARM64 | 対応 | native ARM64 CI、package／UI E2E | 2026-08-16にv0.2.1 installer、shortcut、起動、同梱デモを確認 |
| Windows 10以降 x64 | 対応 | native x64 CI、package／UI E2E | 2026-08-16にWindows 11 x64物理端末でv0.2.1 installer、Desktop／Start Menu起動、同梱8枚デモ、発表前check、Presenter、未保存終了を確認 |
| Windows 10 ARM64 | 対応（実機未確認） | Electron公式binaryとpackage静的検証 | 実機未確認。問題報告はversionと端末を添える |
| Windows x86（32-bit） | 非対応 | なし | 配布物なし |
| macOS／Linux | 非対応 | なし | 配布物なし |

配布物名にはarchitectureを含めます。

- ARM64: `HTML.Slide.Studio.Setup.<version>-arm64.exe`
- x64: `HTML.Slide.Studio.Setup.<version>-x64.exe`

architectureが分からない場合は、Windowsの「設定 → システム → バージョン情報」にある「システムの種類」を確認してください。Snapdragon搭載PCは通常ARM64、Intel／AMD搭載PCは通常x64です。

Electronの公式platform条件は[Windows 10以降、x64／ARM64 binary提供](https://github.com/electron/electron#platform-support)です。ただし、frameworkの対応と本製品の実機確認は別に記録し、未確認環境を確認済みとは扱いません。
