// Kyrgyz the way Bishkek writes it: the style guide, how the V4 prompt uses it, and the reply
// guards and booking gate that have to understand code-switched Kyrgyz. Everything here is
// deterministic; how the model actually phrases a reply is checked by the live run
// (qa/assistant-sim, category "language").
//
// Run: bun test --isolate wa-kyrgyz-style

import { describe, expect, test } from "bun:test";
import {
  KY_APOLOGY_LOOP_RE,
  KY_FAKE_BUSY_RE,
  KY_OFFER_RE,
  KY_STALL_RE,
  KY_SUMMARY_RE,
  kyrgyzRegister,
  languageFinalCheck,
  languageStyleBlock,
} from "@/lib/wa-language-style";
import { buildSystemPromptV4, executeV4Tool, photoAskFallback } from "@/lib/wa-agent-v4.server";
import { confidentLanguage, detectLanguage, type WaAgentInput } from "@/lib/wa-agent.server";

function inputFor(over: Partial<WaAgentInput> & { text?: string } = {}): WaAgentInput {
  const { text, ...rest } = over;
  return {
    salon: { salonId: "s1", salonName: "Тест", timezone: "Asia/Bishkek" },
    config: { industry: "beauty", languages: ["ru", "ky"], manage_cutoff_hours: 0 } as any,
    client: { phone: "996700000001", name: null },
    history: [],
    lastMessages: text
      ? [
          {
            id: "m1",
            direction: "in",
            kind: "text",
            text_body: text,
            created_at: new Date().toISOString(),
          } as any,
        ]
      : [],
    branches: [],
    selectedBranchId: null,
    state: "collecting",
    stateData: {},
    salonInfo: { working_hours: null, address: null },
    ...rest,
  } as WaAgentInput;
}

const ky = (input: WaAgentInput) => buildSystemPromptV4(input, [], "", "ky", "");

describe("kyrgyzRegister: how the client writes", () => {
  test("almost pure Kyrgyz reads as pure", () => {
    expect(
      kyrgyzRegister(["Саламатсызбы! Эртең саат 12ге маникюрга жазылсам болобу?"]).register,
    ).toBe("pure");
  });

  test("service names and «мастер» do not make a client mixed — everyone says them", () => {
    expect(kyrgyzRegister(["Мастерге маникюр жасатсам болобу, эртең кечинде?"]).register).toBe(
      "pure",
    );
  });

  test("the Bishkek mix reads as mixed, and the client's own Russian words come back", () => {
    const r = kyrgyzRegister(["Эртеңге свободно барбы?", "Маникюрга запись керек"]);
    expect(r.register).toBe("mixed");
    expect(r.russianWords).toContain("свободно");
    expect(r.russianWords).toContain("запись");
  });

  test("real client lines from production: Russian stems with Kyrgyz endings still count", () => {
    expect(kyrgyzRegister(["Оплатасын Мплюс менен толосом болобу?"]).register).toBe("mixed");
    expect(kyrgyzRegister(["Кийинки неделя келейинчи э"]).register).toBe("mixed");
    expect(kyrgyzRegister(["Анда субботага жазып коюңуз"]).register).toBe("mixed");
  });

  test("Kyrgyz particles that look Russian («да», «же», «ко») are not Russian", () => {
    expect(kyrgyzRegister(["Жакшы да, анан эртең же бүрсүгүнү келем ко"]).register).toBe("pure");
  });

  test("too little text is no evidence either way", () => {
    expect(kyrgyzRegister(["Салам"]).register).toBeNull();
    expect(kyrgyzRegister([]).register).toBeNull();
  });

  test("one Russian word in a long Kyrgyz message is not a style", () => {
    expect(
      kyrgyzRegister([
        "Саламатсызбы, эртең саат 12ге маникюрга жазылсам болобу, кечинде бошмун, удобно",
      ]).register,
    ).toBeNull();
  });
});

describe("Kyrgyz style guide", () => {
  const guide = languageStyleBlock("ky");

  test("the norm: Kyrgyz base, everyday Russian words, the reference line", () => {
    expect(guide).toContain("ОСНОВА — КЫРГЫЗСКАЯ");
    expect(guide).toContain("РУССКИЕ СЛОВА — ЭТО НОРМАЛЬНО");
    for (const w of ["услуга", "запись", "мастер", "свободно", "удобно", "фото", "цена"]) {
      expect(guide).toContain(w);
    }
    expect(guide).toContain("Эртеңге 15:00 жана 17:30 свободно экен. Кайсысы сизге удобнее?");
    expect(guide).toContain("НЕ 50/50");
  });

  test("names the failures seen in production, so the model can recognise them", () => {
    expect(guide).toContain("кирпик өстүрүү"); // translated price list
    expect(guide).toContain("нымдуу эффект");
    expect(guide).toContain("чебер"); // instead of «мастер»
    expect(guide).toContain("Кечиресиз, бирок");
    expect(guide).toContain("Сизге кантип жардам бере алам?");
    expect(guide).toContain("«неделя» — не отвечай «жума»");
  });

  test("a stall is never offered as a good phrase — the reply guards would bounce it", () => {
    // The first version listed «Азыр карап көрөйүн» among the natural connectors, while the
    // stall guard treats exactly that as a stall and forces a retry.
    const lines = guide.split("\n").filter((l) => l.includes("Азыр карап көрөйүн"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("нельзя");
  });

  test("the good examples do not use the calques the guide forbids", () => {
    const good = guide
      .split("\n")
      .filter((l) => l.startsWith("— ") && !l.startsWith("— Плохо"))
      .join("\n");
    for (const bad of [
      "Кечиресиз, бирок",
      "кантип жардам",
      "маалымат",
      "кайрылыңыз",
      "шилтеме",
      "кирпик өстүрүү",
      "чебер",
    ]) {
      expect(good).not.toContain(bad);
    }
  });

  test("mirrors the client", () => {
    expect(languageStyleBlock("ky", { register: "pure" })).toContain("почти чисто по-кыргызски");
    const mixed = languageStyleBlock("ky", {
      register: "mixed",
      clientRussianWords: ["свободно", "запись"],
    });
    expect(mixed).toContain("сам вставляет русские слова («свободно», «запись»)");
    expect(languageStyleBlock("ky", { register: null })).not.toContain("КАК ПИШЕТ ЭТОТ КЛИЕНТ");
  });

  test("clinics get their own vocabulary and no photo pricing", () => {
    const clinic = languageStyleBlock("ky", { specialist: "врач" });
    expect(clinic).toContain("«врач», а не «дарыгер»");
    expect(clinic).toContain("консультацияга");
    expect(clinic).not.toContain("Фото жиберип");
  });

  test("Russian and English pay nothing", () => {
    expect(languageStyleBlock("ru", { register: "mixed" })).toBe("");
    expect(languageFinalCheck("ru")).toBe("");
    expect(languageFinalCheck("en")).toBe("");
  });
});

describe("V4 prompt in Kyrgyz", () => {
  test("the language rule allows everyday Russian words and still forbids Russian sentences", () => {
    const p = ky(inputFor());
    expect(p).toContain("ЯЗЫК ЭТОГО ДИАЛОГА — КЫРГЫЗСКИЙ");
    expect(p).toContain("НЕ смешение языков");
    expect(p).toContain("целые русские предложения");
    // The old wording, which made the model translate the price list, is gone for Kyrgyz…
    expect(p).not.toContain("Ни одного слова, фразы или строки на другом языке");
    expect(p).toContain("смешением не считаются");
  });

  test("…and Russian and English prompts keep the zero-mixing rule word for word", () => {
    for (const lang of ["ru", "en"] as const) {
      const p = buildSystemPromptV4(inputFor(), [], "", lang, "");
      expect(p).toContain("НУЛЕВАЯ ТЕРПИМОСТЬ К СМЕШЕНИЮ");
      expect(p).toContain("Ни одного слова, фразы или строки на другом языке");
      expect(p).not.toContain("ЯЗЫК ЭТОГО ДИАЛОГА — КЫРГЫЗСКИЙ");
      expect(p).not.toContain("смешением не считаются");
      expect(p).not.toContain("ПРОВЕРЬ КЫРГЫЗСКИЙ");
    }
  });

  test("the booking summary is a Kyrgyz template, not the Russian one with a Kyrgyz tail", () => {
    const p = ky(inputFor());
    expect(p).toContain("Текшерип коюңузчу:");
    expect(p).toContain("🙍 Атыңыз:");
    expect(p).toContain("«ооба» деп жазып коюңуз");
    expect(p).not.toContain("Пожалуйста, подтвердите запись:");

    const ru = buildSystemPromptV4(inputFor(), [], "", "ru", "");
    expect(ru).toContain("Пожалуйста, подтвердите запись:");
    expect(ru).not.toContain("Текшерип коюңузчу:");
  });

  test("the summary header the prompt dictates is the one the summary guard recognises", () => {
    expect(KY_SUMMARY_RE.test("Текшерип коюңузчу:\n\n✂️ Услуга: Маникюр")).toBe(true);
    expect(KY_SUMMARY_RE.test("Ссылканы текшерип коюңуз, баары туурабы?")).toBe(false);
  });

  test("the Kyrgyz self-check sits after the generic rules and before the owner's block", () => {
    const p = ky(
      inputFor({
        config: { industry: "beauty", ai_rules: "Всегда называй имена мастеров." } as any,
      }),
    );
    const check = p.indexOf("ПЕРЕД ОТПРАВКОЙ — ПРОВЕРЬ КЫРГЫЗСКИЙ");
    expect(check).toBeGreaterThan(p.indexOf("ЖЕЛЕЗНЫЕ ПРАВИЛА"));
    expect(check).toBeLessThan(p.indexOf("ПРАВИЛА И ФАКТЫ ЭТОГО САЛОНА"));
  });

  test("the prompt tells the model how THIS client writes", () => {
    expect(ky(inputFor({ text: "Эртеңге свободно барбы? Маникюрга запись керек" }))).toContain(
      "КАК ПИШЕТ ЭТОТ КЛИЕНТ: сам вставляет русские слова",
    );
    expect(ky(inputFor({ text: "Эртең саат 12ге маникюрга жазылсам болобу?" }))).toContain(
      "КАК ПИШЕТ ЭТОТ КЛИЕНТ: почти чисто по-кыргызски",
    );
  });

  test("earlier turns count; guard nudges and photo placeholders do not", () => {
    const mixedHistory = {
      v4_history: [
        { role: "user", parts: [{ text: "Маникюрга запись керек, эртеңге свободно барбы?" }] },
        { role: "model", parts: [{ text: "Ооба, 10:00 бош." }] },
      ],
    };
    expect(ky(inputFor({ text: "Ооба", stateData: mixedHistory as any }))).toContain(
      "сам вставляет русские слова",
    );

    const nudgeOnly = {
      v4_history: [
        {
          role: "user",
          parts: [
            { text: "[фото]" },
            {
              text: "СИСТЕМА: ты показал сводку подтверждения БЕЗ строки «🙍 Имя». Запись и время…",
            },
          ],
        },
      ],
    };
    expect(
      ky(
        inputFor({
          text: "Эртең саат 12ге маникюрга жазылсам болобу?",
          stateData: nudgeOnly as any,
        }),
      ),
    ).toContain("почти чисто по-кыргызски");
  });

  test("a Russian conversation gets no Kyrgyz blocks at all", () => {
    const p = buildSystemPromptV4(
      inputFor({ text: "Здравствуйте, можно на маникюр?" }),
      [],
      "",
      "ru",
      "",
    );
    expect(p).not.toContain("ЖИВОЙ КЫРГЫЗСКИЙ");
    expect(p).not.toContain("КАК ПИШЕТ ЭТОТ КЛИЕНТ");
  });
});

describe("Kyrgyz arms of the reply guards", () => {
  test("stalls", () => {
    for (const s of [
      "Бир минут, азыр проверить кылам",
      "Бир секунд 🙏",
      "Күтүп туруңуз",
      "Азыр уточнить кылып берем",
    ]) {
      expect(KY_STALL_RE.test(s)).toBe(true);
    }
    for (const s of [
      "Эртеңге 11:00 жана 16:30 свободно. Кайсысы сизге удобно?",
      "Бир аздан кийин кайра жазып көрүңүз",
      "Процедура 90 минут болот",
    ]) {
      expect(KY_STALL_RE.test(s)).toBe(false);
    }
  });

  test("«could not open the schedule» — hands off like the Russian apology does", () => {
    for (const s of [
      "Кечиресиз, азыр расписаниени ача албай жатам 🙏",
      "Графикти көрө албай жатам",
      "Маалыматты ала алган жокмун",
    ]) {
      expect(KY_APOLOGY_LOOP_RE.test(s)).toBe(true);
    }
    for (const s of ["Расписаниени көрө алам", "Эртеңки расписание боюнча 15:00 свободно"]) {
      expect(KY_APOLOGY_LOOP_RE.test(s)).toBe(false);
    }
  });

  test("«no free time» in mixed Kyrgyz", () => {
    for (const s of [
      "Эртеңге свободно жок 😔",
      "Эртең бош убакыт жок",
      "15:00 бош эмес",
      "Айгуль эртең занят экен",
      "Окошко жок",
    ]) {
      expect(KY_FAKE_BUSY_RE.test(s)).toBe(true);
    }
    for (const s of [
      "Бизде татуаж жок, бирок коррекция бар",
      "Эртеңге 11:00 жана 16:30 свободно",
      "Предоплата жок, келип эле төлөйсүз",
      "Убактыңыз болсо, эртең келиңиз",
    ]) {
      expect(KY_FAKE_BUSY_RE.test(s)).toBe(false);
    }
  });

  test("an offer of times in Kyrgyz", () => {
    for (const s of [
      "Эртеңге 15:00 бош",
      "15:00гө жазып коёюнбу?",
      "11:00 же 16:30, кайсысы сизге удобно?",
    ]) {
      expect(KY_OFFER_RE.test(s)).toBe(true);
    }
    for (const s of ["Эртең 10:00дөн 20:00гө чейин иштейбиз", "Кайсы убакыт болсо да жазыңыз"]) {
      expect(KY_OFFER_RE.test(s)).toBe(false);
    }
  });
});

describe("booking confirmation gate understands a Kyrgyz yes", () => {
  const igInput = () =>
    inputFor({ channel: "instagram", client: { phone: "", name: null } } as any);
  const flags = () =>
    ({
      appointmentId: null,
      selectedBranchId: null,
      needsHuman: false,
      escalateReason: null,
      photoNotes: [],
    }) as any;
  const book = (confirmation: string, name: string) =>
    executeV4Tool(
      "create_appointment",
      {
        service_id: "11111111-1111-4111-8111-111111111111",
        master_id: "22222222-2222-4222-8222-222222222222",
        date: "2099-01-01",
        time: "10:00",
        client_name: name,
        client_confirmation: confirmation,
      },
      igInput(),
      null as any,
      flags(),
    );

  test("«болот», «мейли», «ок», «баары туура» are a yes", async () => {
    // A placeholder name stops the call at the NEXT gate — proof it passed this one.
    for (const yes of ["Болот", "Мейли", "Ок", "Окей", "Баары туура", "Болот, жазып коюңуз"]) {
      expect((await book(yes, "Клиент")).reason).toBe("need_client_name");
    }
  });

  test("questions and «окошко» are still not a yes", async () => {
    for (const no of ["окошко барбы?", "Болобу?", "Эртеңби?", "Кайсы мастер?"]) {
      expect((await book(no, "Клиент")).reason).toBe("need_explicit_confirmation");
    }
  });

  test("a client called Болот saying their name is not a confirmation", async () => {
    expect((await book("Болот", "Болот")).reason).toBe("need_explicit_confirmation");
    // …but the same client's «ооба» is (stops at the Instagram phone gate, after the name gate).
    expect((await book("Ооба", "Болот")).reason).toBe("need_client_phone");
  });
});

describe("mixed Kyrgyz is detected as Kyrgyz", () => {
  test("Kyrgyz glue words without ң/ү/ө", () => {
    for (const t of [
      "Маникюрга запись барбы?",
      "Бугунку свободно болобу?",
      "Эртенге жазылса болобу",
      "Кайсы мастер жасайт?",
      "Азыр келсем болобу",
    ]) {
      expect(detectLanguage(t)).toBe("ky");
      expect(confidentLanguage(t)).toBe(true);
    }
  });

  test("Russian stays Russian", () => {
    for (const t of [
      "Здравствуйте",
      "Можно на маникюр завтра?",
      "Сколько стоит кератин?",
      "Анна, добрый день, какой мастер свободен?",
    ]) {
      expect(detectLanguage(t)).toBe("ru");
    }
  });
});

test("the Kyrgyz photo request asks once, in the words people use", () => {
  const ask = photoAskFallback([{ line: "Пришлите, пожалуйста, фото волос" }], "ky");
  expect(ask).toBe("Фото жиберип коёсузбу? Баасын так айтып берем 🙂");
});
