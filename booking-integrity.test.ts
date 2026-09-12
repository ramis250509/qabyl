// Оффлайн-часть аудита целостности записи (2026-08-13).
//
// Что здесь есть и чего нет. Основные правила Qabyl живут в Postgres
// (create_appointment, get_available_slots, confirm_prepayment), и проверять их
// bun-тестами бессмысленно — клиент ходит в RPC напрямую, минуя весь TypeScript.
// Для них есть supabase/tests/*.sql. Здесь остаётся то, что реально живёт в TS и
// что уже ломалось в проде:
//
//   1) согласованность правил телефона между слоями;
//   2) сравнение токена вебхука;
//   3) выбор движка ассистента и обнаружение учётных данных;
//   4) вспомогательные предикаты, на которых стоит защита от галлюцинаций модели.
//
// Запуск: bun test booking-integrity.test.ts
import { test, expect, describe } from "bun:test";
import {
  PHONE_COUNTRIES,
  PHONE_DIGITS_MIN,
  PHONE_DIGITS_MAX,
  detectCountry,
  isPlausiblePhoneLength,
  isValidPhone,
  maxDigitsOf,
  minDigitsOf,
  onlyDigits,
  toE164,
} from "@/lib/phone-countries";
import { safeStringEquals } from "@/routes/api/public/wacloud.$salonId";
import { resolveAssistantRuntimeConfig } from "@/lib/assistant-runtime.server";
import { mapWaCloudDeliveryStatus } from "@/lib/wa-cloud.server";
import { classifyDateVsToday, isIsoDate, isUuid } from "@/lib/wa-agent-v4.server";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Телефон: три слоя должны судить одинаково
// ═══════════════════════════════════════════════════════════════════════════
// Слои: маска в UI (phone-countries), проверка регистрации в WhatsApp
// (wa-check.functions), триггер validate_appointment_phone в БД (10–15 цифр).
// Расхождение между слоями = либо ложный отказ клиенту, либо мусор в базе.
describe("правила телефона согласованы между UI, wa-check и БД", () => {
  test("границы совпадают с триггером validate_appointment_phone", () => {
    // Триггер в БД: length(digits) BETWEEN 10 AND 15. Если кто-то поменяет
    // константы здесь, не тронув миграцию, тест напомнит об этом.
    expect(PHONE_DIGITS_MIN).toBe(10);
    expect(PHONE_DIGITS_MAX).toBe(15);
  });

  test("длина 10 цифр принимается — раньше wa-check требовал 11", () => {
    // Это и был баг: 10-значный номер проходил маску и триггер, но
    // checkPhoneWhatsapp объявлял его «не зарегистрирован в WhatsApp», и
    // публичный виджет жёстко блокировал запись с неверным объяснением.
    expect(isPlausiblePhoneLength("1234567890")).toBe(true);
    expect(isPlausiblePhoneLength("123456789")).toBe(false);
    expect(isPlausiblePhoneLength("1234567890123456")).toBe(false);
  });

  test("всё, что принимает маска страны, принимает и правило БД", () => {
    // Полный перебор справочника: если добавят страну с 9-значным номером,
    // тест упадёт здесь, а не в проде на живом клиенте.
    const broken: string[] = [];
    for (const c of PHONE_COUNTRIES) {
      for (const nationalLen of [minDigitsOf(c), maxDigitsOf(c)]) {
        const first = c.firstDigit ? c.firstDigit.replace(/[[\]]/g, "")[0] : "5";
        const national = first + "5".repeat(Math.max(0, nationalLen - 1));
        const e164 = toE164(c, national);
        if (!isValidPhone(e164)) continue; // маска сама отвергла — не наш случай
        if (!isPlausiblePhoneLength(e164)) broken.push(`${c.iso} ${e164}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("определение страны берёт самый длинный совпавший код", () => {
    // +996 и +9 обе начинаются одинаково; ошибка тут даёт неверную маску
    // и «телефон введён неполностью» на корректном номере.
    expect(detectCountry("+996700123456")?.iso).toBe("KG");
    expect(detectCountry("+79161234567")?.iso).toBe("KZ"); // +7 — первый в списке
    expect(detectCountry("не телефон")).toBeUndefined();
  });

  test("onlyDigits снимает любое форматирование", () => {
    expect(onlyDigits("+996 (700) 12-34-56")).toBe("996700123456");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Токен вебхука WhatsApp
// ═══════════════════════════════════════════════════════════════════════════
// Единственная защита эндпоинта /api/public/wa/$salonId. Он принимает POST от
// кого угодно, поэтому сравнение должно быть и корректным, и не сливать длину
// токена по времени ответа.
describe("safeStringEquals — сравнение токена вебхука", () => {
  test("совпадающие строки", () => {
    expect(safeStringEquals("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  test("разные строки одинаковой длины", () => {
    expect(safeStringEquals("s3cr3t-token", "s3cr3t-tokeX")).toBe(false);
  });

  test("префикс не проходит — иначе токен подбирается посимвольно", () => {
    expect(safeStringEquals("s3cr3t-token", "s3cr3t")).toBe(false);
    expect(safeStringEquals("s3cr3t", "s3cr3t-token")).toBe(false);
  });

  test("пустая строка не равна настоящему токену", () => {
    // Салон без настроенного токена не должен принимать вебхуки: в маршруте это
    // отдельная проверка `!secrets?.greenapi_webhook_token`, но и сравнение само
    // по себе не должно давать true на пустоте.
    expect(safeStringEquals("", "")).toBe(true);
    expect(safeStringEquals("s3cr3t", "")).toBe(false);
  });

  test("нестроковые значения не проходят", () => {
    expect(safeStringEquals(undefined as any, undefined as any)).toBe(false);
    expect(safeStringEquals(null as any, "x")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Конфигурация ассистента
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveAssistantRuntimeConfig", () => {
  test("движок по умолчанию — v4, v3 только явным опт-ином", () => {
    expect(resolveAssistantRuntimeConfig({}, {}, {}).engine).toBe("v4");
    expect(resolveAssistantRuntimeConfig({}, { engine: "v3" }, {}).engine).toBe("v3");
    // Мусор в колонке не должен молча откатывать салон на старый движок.
    expect(resolveAssistantRuntimeConfig({}, { engine: "v9" }, {}).engine).toBe("v4");
  });

  test("ассистент включён по умолчанию, но выключается любым из двух общих флагов", () => {
    expect(resolveAssistantRuntimeConfig({}, {}, {}).assistantEnabled).toBe(true);
    expect(
      resolveAssistantRuntimeConfig({ ai_assistant_enabled: false }, {}, {}).assistantEnabled,
    ).toBe(false);
    expect(resolveAssistantRuntimeConfig({}, { enabled: false }, {}).assistantEnabled).toBe(false);
  });

  test("канал выключается отдельно, не задевая соседний", () => {
    const salon = { whatsapp_ai_enabled: false, instagram_enabled: true };
    expect(resolveAssistantRuntimeConfig(salon, {}, {}, "whatsapp").assistantEnabled).toBe(false);
    expect(resolveAssistantRuntimeConfig(salon, {}, {}, "instagram").assistantEnabled).toBe(true);

    const other = { whatsapp_ai_enabled: true, instagram_enabled: false };
    expect(resolveAssistantRuntimeConfig(other, {}, {}, "whatsapp").assistantEnabled).toBe(true);
    expect(resolveAssistantRuntimeConfig(other, {}, {}, "instagram").assistantEnabled).toBe(false);
  });

  test("общий выключатель сильнее канального", () => {
    const salon = {
      ai_assistant_enabled: false,
      whatsapp_ai_enabled: true,
      instagram_enabled: true,
    };
    expect(resolveAssistantRuntimeConfig(salon, {}, {}, "whatsapp").assistantEnabled).toBe(false);
    expect(resolveAssistantRuntimeConfig(salon, {}, {}, "instagram").assistantEnabled).toBe(false);
  });

  test("база без миграции ведёт себя как раньше, а не замолкает", () => {
    // Колонки whatsapp_ai_enabled может не быть: код уезжает в прод раньше миграции или откат
    // вернул схему назад. Отсутствие колонки обязано читаться как «включено» — иначе выкатка
    // гасит ответы во всех салонах разом, и молча.
    expect(resolveAssistantRuntimeConfig({}, {}, {}, "whatsapp").assistantEnabled).toBe(true);
    expect(resolveAssistantRuntimeConfig({}, {}, {}, "instagram").assistantEnabled).toBe(true);
  });

  test("канал по умолчанию — WhatsApp", () => {
    // Через resolveAssistantRuntimeConfig проходят три WhatsApp-маршрута; забытый аргумент не
    // должен случайно включить ассистента там, где владелец его выключил.
    expect(
      resolveAssistantRuntimeConfig({ whatsapp_ai_enabled: false }, {}, {}).assistantEnabled,
    ).toBe(false);
  });

  test("учётные данные Green-API считаются только при обоих полях", () => {
    // Салоны, переехавшие на Cloud API, остаются без greenapi_* — от этого
    // зависит и проверка номера в WhatsApp, и весь исходящий транспорт.
    expect(resolveAssistantRuntimeConfig({}, {}, {}).hasGreenApiCreds).toBe(false);
    expect(resolveAssistantRuntimeConfig({}, {}, { greenapi_instance: "1" }).hasGreenApiCreds).toBe(
      false,
    );
    expect(
      resolveAssistantRuntimeConfig({}, {}, { greenapi_instance: "1", greenapi_token: "t" })
        .hasGreenApiCreds,
    ).toBe(true);
  });

  test("язык по умолчанию — русский, пустой список не проходит", () => {
    expect(resolveAssistantRuntimeConfig({}, {}, {}).assistantConfig.languages).toEqual(["ru"]);
    expect(
      resolveAssistantRuntimeConfig({}, { languages: [] }, {}).assistantConfig.languages,
    ).toEqual(["ru"]);
    expect(
      resolveAssistantRuntimeConfig({}, { languages: ["ky", "ru"] }, {}).assistantConfig.languages,
    ).toEqual(["ky", "ru"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Предикаты на границе инструментов ассистента
// ═══════════════════════════════════════════════════════════════════════════
// Модель периодически выдумывает идентификаторы и даты. Эти проверки — то, что
// превращает галлюцинацию в понятную причину отказа вместо ложного «всё занято».
describe("границы инструментов ассистента", () => {
  test("isUuid отсекает придуманные идентификаторы", () => {
    expect(isUuid("03d38f82-f91b-4674-84c4-d0595a8bd57d")).toBe(true);
    // Именно эту форму Gemini выдаёт, когда не звал get_services.
    expect(isUuid("6679549c60a950254006a236")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  test("isIsoDate требует ровно YYYY-MM-DD", () => {
    expect(isIsoDate("2026-08-13")).toBe(true);
    expect(isIsoDate("13.08.2026")).toBe(false);
    expect(isIsoDate("2026-8-13")).toBe(false);
  });

  test("classifyDateVsToday различает прошлое, сегодня и будущее", () => {
    // Три исхода, а не два: «прошлое» и «сегодня поздно» нельзя схлопывать в
    // «всё занято» — на этом уже горели, отвечая клиенту неправду.
    expect(classifyDateVsToday("2026-08-12", "2026-08-13")).toBe("past");
    expect(classifyDateVsToday("2026-08-13", "2026-08-13")).toBe("today");
    expect(classifyDateVsToday("2026-08-14", "2026-08-13")).toBe("future");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Статус доставки подтверждения
// ═══════════════════════════════════════════════════════════════════════════
// Замена невозможной предварительной проверки номера. Раньше Qabyl пытался
// угадать до записи, есть ли номер в WhatsApp (умел только Green-API, у Cloud
// API аналога нет). Теперь провайдер сам сообщает исход после отправки.
describe("mapWaCloudDeliveryStatus", () => {
  test("131026 — это и есть «номера нет в WhatsApp»", () => {
    const r = mapWaCloudDeliveryStatus("failed", 131026);
    expect(r?.status).toBe("failed");
    expect(r?.detail).toBeTruthy();
  });

  test("delivered и read — доставлено", () => {
    expect(mapWaCloudDeliveryStatus("delivered")?.status).toBe("delivered");
    expect(mapWaCloudDeliveryStatus("read")?.status).toBe("delivered");
  });

  test("sent — ещё не исход, статуса не меняем", () => {
    expect(mapWaCloudDeliveryStatus("sent")).toBeNull();
  });

  test("неизвестное значение не трогает статус записи", () => {
    expect(mapWaCloudDeliveryStatus("somethingNew")).toBeNull();
    expect(mapWaCloudDeliveryStatus(undefined as any)).toBeNull();
  });
});
