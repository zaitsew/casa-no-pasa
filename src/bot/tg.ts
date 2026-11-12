/**
 * Minimal Telegram Bot API client. The bot token sits in every request path, so nothing here logs or
 * throws a URL: an error names the method, the HTTP status and Telegram's own description only.
 */

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  /** Telegram's copy button only takes 1-256 characters. */
  copy_text?: { text: string };
}
export type Keyboard = InlineButton[][];

/** Telegram cuts button labels to fit the row: with a long label, put at most two buttons in a row. */
export function buttonRows(btns: InlineButton[]): Keyboard {
  const perRow = btns.some((b) => b.text.length > 8) ? 2 : btns.length || 1;
  const rows: Keyboard = [];
  for (let i = 0; i < btns.length; i += perRow) rows.push(btns.slice(i, i + perRow));
  return rows;
}

export class TgError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
  ) {
    super(`telegram ${method} failed (${status}): ${description}`.slice(0, 200));
  }
}

export interface SendOptions {
  keyboard?: Keyboard;
  /** Default HTML. Pass "none" for plain text. */
  parse?: "HTML" | "none";
}

export interface Tg {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: SendOptions): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, keyboard: Keyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action?: "typing" | "upload_photo"): Promise<void>;
  /** Telegram's file path for a file id. */
  getFile(fileId: string): Promise<{ path: string; size?: number }>;
  downloadFile(path: string): Promise<Buffer>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>, languageCode?: string): Promise<void>;
}

/** Telegram's limit is 4096 characters; stay inside it. */
export const MAX_TEXT = 4000;

export function createTg(opts: { token?: string; fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): Tg {
  const token = (opts.token ?? (opts.env ?? process.env).TELEGRAM_BOT_TOKEN ?? "").trim();
  const doFetch = opts.fetch ?? fetch;

  async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!token) throw new TgError(method, 0, "TELEGRAM_BOT_TOKEN is not set");
    let res: Response;
    try {
      res = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TgError(method, 0, "network error");
    }
    const text = await res.text();
    let parsed: { ok?: boolean; result?: T; description?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || parsed.ok !== true) throw new TgError(method, res.status, String(parsed.description ?? "no description").slice(0, 120));
    return parsed.result as T;
  }

  // Safety net: slicing HTML can cut a tag or an entity and Telegram then rejects the message. Callers
  // shorten plain text before escaping (see cards.ts); anything still too long is sent as plain text.
  const plainOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const textBody = (text: string, o?: SendOptions) => {
    const tooLong = text.length > MAX_TEXT;
    const asPlain = o?.parse === "none" || tooLong;
    const body = o?.parse === "none" ? text : tooLong ? plainOf(text) : text;
    return {
      text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body,
      ...(asPlain ? {} : { parse_mode: "HTML" }),
      link_preview_options: { is_disabled: true },
      ...(o?.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
    };
  };
  return {
    async sendMessage(chatId, text, o) {
      const r = await call<{ message_id: number }>("sendMessage", { chat_id: chatId, ...textBody(text, o) });
      return r.message_id;
    },
    async editMessageText(chatId, messageId, text, o) {
      try {
        await call("editMessageText", { chat_id: chatId, message_id: messageId, ...textBody(text, o) });
      } catch (err) {
        if (err instanceof TgError && /message is not modified/i.test(err.message)) return;
        throw err;
      }
    },
    async editMessageReplyMarkup(chatId, messageId, keyboard) {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    },
    async answerCallbackQuery(id, text) {
      await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) });
    },
    async sendChatAction(chatId, action = "typing") {
      await call("sendChatAction", { chat_id: chatId, action });
    },
    async getFile(fileId) {
      const r = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
      if (!r.file_path) throw new TgError("getFile", 200, "no file_path");
      return { path: r.file_path, ...(r.file_size !== undefined ? { size: r.file_size } : {}) };
    },
    async downloadFile(path) {
      if (!token) throw new TgError("downloadFile", 0, "TELEGRAM_BOT_TOKEN is not set");
      let res: Response;
      try {
        res = await doFetch(`https://api.telegram.org/file/bot${token}/${path}`);
      } catch {
        throw new TgError("downloadFile", 0, "network error");
      }
      if (!res.ok) throw new TgError("downloadFile", res.status, "download failed");
      return Buffer.from(await res.arrayBuffer());
    },
    async setWebhook(url, secretToken) {
      await call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    },
    async setMyCommands(commands, languageCode) {
      await call("setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });
    },
  };
}
