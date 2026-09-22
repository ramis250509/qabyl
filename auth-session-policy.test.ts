// Единственное необратимое действие кабинета — отправить человека на экран входа. Здесь
// проверяется правило, по которому это решение принимается.
//
// Контекст жалобы, из которой выросло правило: у владелицы салона PWA «с того ни с сего»
// показывала экран входа. Сессия при этом была цела — её удалял supabase-js после одной
// неудачной попытки обновить токен, в том числе когда неудача была сетевой.
import { describe, expect, test } from "bun:test";
import { isTokenRejected } from "./src/lib/auth-session-policy";

describe("что считается настоящей потерей доступа", () => {
  test("нет ошибки — нет и повода выгонять", () => {
    expect(isTokenRejected(null)).toBe(false);
  });

  test("отозванный refresh-токен — настоящий выход", () => {
    expect(
      isTokenRejected({ name: "AuthApiError", status: 400, code: "refresh_token_not_found" }),
    ).toBe(true);
  });

  test("использованный повторно токен — тоже настоящий выход", () => {
    expect(
      isTokenRejected({ name: "AuthApiError", status: 400, code: "refresh_token_already_used" }),
    ).toBe(true);
  });

  test("заблокированный пользователь — настоящий выход", () => {
    expect(isTokenRejected({ name: "AuthApiError", status: 403, code: "user_banned" })).toBe(true);
  });
});

describe("что НЕ считается потерей доступа", () => {
  // Ровно эти случаи и выкидывали владелицу салона из кабинета.
  test("нет сети — телефон только проснулся, а не вышел из аккаунта", () => {
    expect(isTokenRejected({ name: "AuthRetryableFetchError", status: 0 })).toBe(false);
  });

  test("Supabase отвечает 503 — это не про права доступа", () => {
    expect(isTokenRejected({ name: "AuthRetryableFetchError", status: 503 })).toBe(false);
  });

  test("любая 5xx временна, как бы она ни называлась", () => {
    for (const status of [500, 502, 504, 520, 530]) {
      expect(isTokenRejected({ name: "AuthApiError", status })).toBe(false);
    }
  });

  test("незнакомый код без статуса трактуется в пользу человека", () => {
    expect(isTokenRejected({ name: "AuthUnknownError", code: "something_new" })).toBe(false);
  });

  test("пустая ошибка не выгоняет", () => {
    expect(isTokenRejected({})).toBe(false);
  });
});
