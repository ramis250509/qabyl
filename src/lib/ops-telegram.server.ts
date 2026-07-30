// Telegram Bot API helper — SERVER ONLY. Used by the internal ops-agents subsystem
// (/api/internal/**). Bot token is read PER-REQUEST from process.env (Cloudflare binds
// env at request time; module-scope reads resolve to undefined — see config.server.ts).
//
// Free, no per-message cost. We use plain HTTPS calls to api.telegram.org — no SDK.

const API_BASE = "https://api.telegram.org";

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

// ---- Types (only the slice of the Bot API we touch) ------------------------

export interface TgInlineButton {
  text: string;
  callback_data: string; // keep <64 bytes; we store real actions in ops_approvals
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string; // 'private' | 'group' | 'supergroup'
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number; // forum topic id
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ---- Low-level call --------------------------------------------------------

async function call<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    // Never throw on send failures in agent paths — callers decide. Log for wrangler tail.
    console.error(`[ops-tg] ${method} failed:`, res.status, json?.description ?? "");
    return json as T;
  }
  return json.result as T;
}

// ---- Public helpers --------------------------------------------------------

/** Build an inline keyboard from rows of buttons. */
export function inlineKeyboard(rows: TgInlineButton[][]) {
  return { inline_keyboard: rows };
}

/**
 * Send a message. `threadId` targets a forum topic (optional — when unset the message
 * lands in the main chat / DM). Returns the created message_id (or null on failure).
 */
export async function sendMessage(opts: {
  chatId: string | number;
  text: string;
  threadId?: number | null;
  buttons?: TgInlineButton[][];
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disablePreview?: boolean;
}): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    disable_web_page_preview: opts.disablePreview ?? true,
  };
  if (opts.threadId) body.message_thread_id = opts.threadId;
  if (opts.buttons) body.reply_markup = inlineKeyboard(opts.buttons);
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  const msg = await call<TgMessage>("sendMessage", body);
  return msg?.message_id ?? null;
}

/** Acknowledge a button tap so Telegram stops the loading spinner. */
export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

/** Replace the text + keyboard of an existing message (e.g. after a decision). */
export async function editMessageText(opts: {
  chatId: string | number;
  messageId: number;
  text: string;
  buttons?: TgInlineButton[][];
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
}): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    text: opts.text,
  };
  body.reply_markup = opts.buttons ? inlineKeyboard(opts.buttons) : { inline_keyboard: [] };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  await call("editMessageText", body);
}
