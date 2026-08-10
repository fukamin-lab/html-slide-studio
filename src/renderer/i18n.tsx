import { createContext, useContext, type ReactNode } from "react";

type MessageKey =
  | "slides"
  | "thumbnail"
  | "palette.bold"
  | "palette.delete"
  | "palette.fillBlue"
  | "palette.fillNone"
  | "palette.fillWhite"
  | "palette.fillYellow"
  | "palette.label"
  | "palette.textBlack"
  | "palette.textBlue"
  | "palette.textRed";

const messages: Record<MessageKey, string> = {
  slides: "スライド",
  thumbnail: "{label} のプレビュー",
  "palette.bold": "太字",
  "palette.delete": "削除",
  "palette.fillBlue": "青の背景",
  "palette.fillNone": "背景なし",
  "palette.fillWhite": "白の背景",
  "palette.fillYellow": "黄色の背景",
  "palette.label": "クイック書式",
  "palette.textBlack": "黒の文字",
  "palette.textBlue": "青の文字",
  "palette.textRed": "赤の文字"
};

type I18nContextValue = {
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue>({ t: formatMessage });

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  return <I18nContext.Provider value={{ t: formatMessage }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

function formatMessage(key: MessageKey, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    messages[key]
  );
}
