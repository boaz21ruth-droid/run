/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 「在 Telegram 中打开」链接里的机器人用户名，构建时注入 */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
