// Состояние канала WhatsApp: что мы говорим владельцу и в каком порядке.
//
// Зачем этот файл. computeWaStatus отвечает на вопрос «почему не работает», и ответ должен быть
// ОДИН — тот, что мешает больше всех. Порядок проверок здесь и есть вся логика: сказать про
// шаблоны на модерации салону с отозванным токеном значит отправить его чинить не то. Порядок
// легко сломать случайной перестановкой блоков, и без теста этого никто не заметит, пока владелец
// не позвонит.
//
// Второй сюжет — статус шаблона. Созданный шаблон приходит PENDING, а не APPROVED; прежний код
// поднимал флаг готовности по факту создания, и каждое напоминание вне 24-часового окна падало с
// кодом 132000. Тесты ниже фиксируют, что PENDING — это «ещё нельзя».
//
// Запуск: bun test wa-connection.test.ts

import { describe, expect, test } from "bun:test";
import { computeWaStatus, type WaConnectionRow } from "./src/lib/wa-connection.server";
import { NOTIFICATION_TEMPLATES } from "./src/lib/wa-onboarding.server";

/** Полностью здоровый салон. Каждый тест портит ровно одну вещь. */
function healthy(over: Partial<WaConnectionRow> = {}): WaConnectionRow {
  const templates: Record<string, any> = {};
  for (const t of NOTIFICATION_TEMPLATES) {
    templates[t.kind] = { name: t.name, lang: "ru", status: "APPROVED" };
  }
  return {
    whatsapp_cloud_phone_number_id: "123",
    whatsapp_cloud_token: "EAAG",
    whatsapp_cloud_waba_id: "waba",
    whatsapp_cloud_templates: templates,
    wa_token_status: "valid",
    wa_last_health_check_at: new Date().toISOString(),
    wa_display_phone_number: "+996 700 000 000",
    wa_quality_rating: "GREEN",
    wa_payment_ready: true,
    ...over,
  };
}

describe("не подключён", () => {
  test("пустая строка — это не поломка, а пустое место", () => {
    const s = computeWaStatus(null);
    expect(s.connected).toBe(false);
    expect(s.code).toBe("not_connected");
    expect(s.level).toBe("idle");
    expect(s.action?.kind).toBe("connect");
  });

  test("номер без токена подключением не считается", () => {
    const s = computeWaStatus({ whatsapp_cloud_phone_number_id: "123" });
    expect(s.connected).toBe(false);
  });

  test("токен без номера — тоже", () => {
    const s = computeWaStatus({ whatsapp_cloud_token: "EAAG" });
    expect(s.connected).toBe(false);
  });
});

describe("порядок причин", () => {
  test("здоровый салон", () => {
    const s = computeWaStatus(healthy());
    expect(s.code).toBe("healthy");
    expect(s.level).toBe("ok");
    // У «всё работает» действия быть не должно: предлагать что-то нажать, когда всё в порядке,
    // значит намекать, что не всё в порядке.
    expect(s.action).toBeUndefined();
  });

  test("отозванный токен перебивает всё остальное", () => {
    const s = computeWaStatus(
      healthy({
        wa_token_status: "invalid",
        wa_payment_ready: false,
        wa_account_review_status: "DISABLED",
        wa_quality_rating: "RED",
      }),
    );
    expect(s.code).toBe("token_invalid");
    expect(s.action?.kind).toBe("reconnect");
  });

  test("бан аккаунта перебивает платёжку и шаблоны", () => {
    const s = computeWaStatus(
      healthy({ wa_account_review_status: "DISABLED", wa_payment_ready: false }),
    );
    expect(s.code).toBe("account_restricted");
  });

  test("отсутствие платёжки перебивает шаблоны — без неё не уйдёт вообще ничего", () => {
    const s = computeWaStatus(healthy({ wa_payment_ready: false, whatsapp_cloud_templates: {} }));
    expect(s.code).toBe("needs_payment");
    expect(s.action?.kind).toBe("add_payment");
  });

  test("непроверенное подключение честно называется непроверенным", () => {
    const s = computeWaStatus(healthy({ wa_last_health_check_at: null }));
    expect(s.code).toBe("never_checked");
    expect(s.action?.kind).toBe("recheck");
  });

  test("красное качество — предупреждение, а не поломка", () => {
    const s = computeWaStatus(healthy({ wa_quality_rating: "RED" }));
    expect(s.code).toBe("quality_low");
    expect(s.level).toBe("warn");
    expect(s.connected).toBe(true);
  });
});

describe("шаблоны", () => {
  test("PENDING — это ещё нельзя отправлять", () => {
    const templates: Record<string, any> = {};
    for (const t of NOTIFICATION_TEMPLATES) {
      templates[t.kind] = { name: t.name, lang: "ru", status: "PENDING" };
    }
    const s = computeWaStatus(healthy({ whatsapp_cloud_templates: templates }));
    expect(s.code).toBe("templates_pending");
    expect(s.level).toBe("warn");
    expect(s.facts.templatesApproved).toBe(0);
    // Канал при этом рабочий: ассистент отвечает внутри окна 24 часов.
    expect(s.connected).toBe(true);
  });

  test("отклонённый шаблон важнее ожидающих", () => {
    const templates: Record<string, any> = {};
    for (const t of NOTIFICATION_TEMPLATES) {
      templates[t.kind] = { name: t.name, lang: "ru", status: "PENDING" };
    }
    templates[NOTIFICATION_TEMPLATES[0].kind].status = "REJECTED";
    const s = computeWaStatus(healthy({ whatsapp_cloud_templates: templates }));
    expect(s.code).toBe("templates_rejected");
    expect(s.action?.kind).toBe("recreate_templates");
  });

  test("шаблон, удалённый в кабинете Meta, не считается рабочим", () => {
    const templates: Record<string, any> = {};
    for (const t of NOTIFICATION_TEMPLATES) {
      templates[t.kind] = { name: t.name, lang: "ru", status: "APPROVED" };
    }
    templates[NOTIFICATION_TEMPLATES[1].kind].status = "MISSING";
    const s = computeWaStatus(healthy({ whatsapp_cloud_templates: templates }));
    expect(s.code).toBe("templates_pending");
    expect(s.facts.templatesApproved).toBe(NOTIFICATION_TEMPLATES.length - 1);
  });

  test("статус без комплекта шаблонов не притворяется готовым", () => {
    const s = computeWaStatus(healthy({ whatsapp_cloud_templates: null }));
    expect(s.facts.templatesApproved).toBe(0);
    expect(s.facts.templatesTotal).toBe(NOTIFICATION_TEMPLATES.length);
    expect(s.code).toBe("templates_pending");
  });
});

describe("что видит владелец", () => {
  test("coexistence распознаётся и меняет объяснение", () => {
    const s = computeWaStatus(healthy({ wa_platform_type: "ON_BIZ_APP" }));
    expect(s.facts.coexistence).toBe(true);
    expect(s.body).toContain("телефоне");
  });

  test("номер, целиком уехавший в API, coexistence не считается", () => {
    const s = computeWaStatus(healthy({ wa_platform_type: "CLOUD_API" }));
    expect(s.facts.coexistence).toBe(false);
  });

  test("качество переводится на человеческий, а не отдаётся кодом Meta", () => {
    expect(computeWaStatus(healthy({ wa_quality_rating: "GREEN" })).facts.quality).toBe("хорошее");
    expect(computeWaStatus(healthy({ wa_quality_rating: "YELLOW" })).facts.quality).toBe("среднее");
    expect(computeWaStatus(healthy({ wa_quality_rating: "UNKNOWN" })).facts.quality).toBeNull();
  });

  test("ни один текст не показывает владельцу внутренние термины", () => {
    const forbidden = /WABA|Phone Number ID|app secret|webhook|вебхук|Graph API|token/i;
    const rows: WaConnectionRow[] = [
      {},
      healthy(),
      healthy({ wa_token_status: "invalid" }),
      healthy({ wa_payment_ready: false }),
      healthy({ wa_account_review_status: "DISABLED" }),
      healthy({ wa_last_health_check_at: null }),
      healthy({ wa_quality_rating: "RED" }),
      healthy({ whatsapp_cloud_templates: {} }),
    ];
    for (const r of rows) {
      const s = computeWaStatus(r);
      expect(`${s.title} ${s.body}`).not.toMatch(forbidden);
    }
  });
});

describe("оплата через платформу (кредитная линия YCloud)", () => {
  test("владельца не отправляют привязывать карту, когда платит платформа", () => {
    const s = computeWaStatus(healthy({ wa_payment_ready: false }), { platformBilling: true });
    expect(s.code).toBe("needs_payment");
    expect(s.action?.kind).toBe("support");
    expect(`${s.title} ${s.body}`).not.toMatch(/карт/i);
  });

  test("без платформенной оплаты — прежний путь в биллинг Meta", () => {
    const s = computeWaStatus(healthy({ wa_payment_ready: false }));
    expect(s.action?.kind).toBe("add_payment");
  });

  test("платформенная оплата не меняет здоровый салон", () => {
    const s = computeWaStatus(healthy(), { platformBilling: true });
    expect(s.code).toBe("healthy");
  });
});
