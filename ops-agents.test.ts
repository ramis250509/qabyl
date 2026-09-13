// Мира и шина событий: разбор ответа модели и правила связи между агентами.
//
// Запуск: bun test ops-agents.test.ts

import { describe, expect, test } from "bun:test";
import {
  contentPlanAction,
  fallbackContentPlan,
  formatContentPlan,
  formatPostBrief,
  parseContentPlan,
  type PlatformFacts,
} from "./src/lib/ops-content";
import { MAX_HOPS, planEventFanout } from "./src/lib/ops-routes";

const facts: PlatformFacts = {
  salons: 3,
  newSalons30d: 0,
  industries: ["beauty"],
  bookings7d: 17,
  aiBookings7d: 9,
  topServices: ["Наращивание ресниц", "Маникюр"],
  noShowRate30d: 12,
};

const goodPlan = JSON.stringify({
  posts: [
    { format: "Пост", hook: "Заголовок", caption: "Текст поста про пользу.", cta: "Написать" },
    { format: "Сторис", hook: "Второй", caption: "Ещё текст.", cta: "Свайп" },
  ],
  promo: {
    title: "Первый месяц",
    audience: "Салоны",
    offer: "30 дней бесплатно",
    why: "Вход без риска",
  },
});

describe("разбор ответа модели", () => {
  test("чистый JSON", () => {
    const p = parseContentPlan(goodPlan);
    expect(p?.posts).toHaveLength(2);
    expect(p?.promo?.title).toBe("Первый месяц");
  });

  test("JSON в markdown-заборе и с болтовнёй вокруг", () => {
    const raw = "Конечно! Вот план:\n```json\n" + goodPlan + "\n```\nГотово.";
    expect(parseContentPlan(raw)?.posts).toHaveLength(2);
  });

  test("мусор вместо JSON — null, вызывающий возьмёт запасной план", () => {
    expect(parseContentPlan("извините, не могу")).toBeNull();
    expect(parseContentPlan("")).toBeNull();
    expect(parseContentPlan("{сломанный")).toBeNull();
  });

  test("посты без текста выбрасываются, годные остаются", () => {
    const raw = JSON.stringify({
      posts: [
        { format: "Пост", hook: "", caption: "нет заголовка" },
        { format: "Пост", hook: "есть", caption: "и текст есть" },
      ],
    });
    const p = parseContentPlan(raw);
    expect(p?.posts).toHaveLength(1);
    expect(p?.promo).toBeNull();
  });

  test("больше трёх постов не берём", () => {
    const raw = JSON.stringify({
      posts: Array.from({ length: 6 }, (_, i) => ({ hook: `h${i}`, caption: `c${i}` })),
    });
    expect(parseContentPlan(raw)?.posts).toHaveLength(3);
  });

  test("промо без предложения не считается промо", () => {
    const raw = JSON.stringify({
      posts: [{ hook: "h", caption: "c" }],
      promo: { title: "Есть заголовок", offer: "" },
    });
    expect(parseContentPlan(raw)?.promo).toBeNull();
  });

  test("длинный текст обрезается, а не ломает сообщение", () => {
    const raw = JSON.stringify({
      posts: [{ hook: "x".repeat(500), caption: "y".repeat(5000) }],
    });
    const p = parseContentPlan(raw)!;
    expect(p.posts[0].hook.length).toBeLessThanOrEqual(120);
    expect(p.posts[0].caption.length).toBeLessThanOrEqual(700);
  });
});

describe("запасной план", () => {
  test("строится из фактов", () => {
    const p = fallbackContentPlan(facts);
    expect(p.posts.length).toBe(3);
    expect(p.posts[0].caption).toContain("17");
    expect(p.posts[0].hook).toContain("9");
  });

  test("промо предлагается, когда новых салонов за месяц не было", () => {
    expect(fallbackContentPlan(facts).promo).not.toBeNull();
    expect(fallbackContentPlan({ ...facts, newSalons30d: 4 }).promo).toBeNull();
  });
});

describe("сообщение владельцу", () => {
  test("содержит все посты и промо", () => {
    const plan = parseContentPlan(goodPlan)!;
    const text = formatContentPlan(plan, facts);
    expect(text).toContain("Заголовок");
    expect(text).toContain("Второй");
    expect(text).toContain("Первый месяц");
  });

  test("без технических слов", () => {
    const text = formatContentPlan(fallbackContentPlan(facts), facts);
    expect(text).not.toMatch(/Gemini|Meta|API|токен|webhook/i);
  });

  test("посты отделены друг от друга — не стена текста", () => {
    const text = formatContentPlan(fallbackContentPlan(facts), facts);
    // Пустые строки между блоками владелец попросил отдельно: без них сообщение нечитаемо.
    expect(text).toContain("\n\n");
    expect(text.split("━━━").length).toBeGreaterThan(3);
    // И никаких тройных переносов: воздух, а не дыры.
    expect(text).not.toMatch(/\n{3}/);
  });

  test("действие для кнопки несёт одобренный текст поста — публикуется именно он", () => {
    const action = contentPlanAction(parseContentPlan(goodPlan)!);
    expect((action as any).posts[0].caption).toBe("Текст поста про пользу.");
    // Кнопка несёт только id строки, но сама строка едет в базу: держим её в разумных размерах.
    expect(JSON.stringify(action).length).toBeLessThan(4000);
  });
});

describe("шина событий", () => {
  test("одобренное промо доходит до продажника и Кэпа", () => {
    const f = planEventFanout("promo.approved", { title: "Первый месяц", offer: "30 дней" }, 0);
    expect(f.tasks.map((t) => t.agent).sort()).toEqual(["chief", "sales"]);
    expect(f.tasks[0].title).toContain("Первый месяц");
  });

  test("цепочка обрывается на пределе прыжков", () => {
    const f = planEventFanout("promo.approved", { title: "X" }, MAX_HOPS);
    expect(f.tasks).toHaveLength(0);
    expect(f.stop).toBe("max_hops");
  });

  test("неизвестное событие никого не будит", () => {
    const f = planEventFanout("что-то.новое", {}, 0);
    expect(f.tasks).toHaveLength(0);
    expect(f.stop).toBe("unknown_type");
  });

  test("инцидент не дублируется: Деби уже положил его на доску", () => {
    const f = planEventFanout("incident.opened", { summary: "followups падает" }, 0);
    expect(f.tasks).toHaveLength(0);
    expect(f.stop).toBeUndefined();
  });

  test("публикация контента задач не плодит — они созданы при одобрении", () => {
    const f = planEventFanout("content.approved", { posts: 3 }, 0);
    expect(f.tasks).toHaveLength(0);
    expect(f.stop).toBeUndefined();
  });

  test("лид без имени опознаётся по телефону", () => {
    const f = planEventFanout("lead.qualified", { phone: "996700112233" }, 1);
    expect(f.tasks[0].title).toContain("996700112233");
  });
});

describe("задание на пост", () => {
  const post = {
    format: "Рилс",
    hook: "Клиент пишет в 23:40",
    caption: "Ассистент отвечает ночью <и> днём & записывает",
    cta: "Подключить",
  };

  test("есть промпт, подпись и хештеги", () => {
    const text = formatPostBrief(post);
    expect(text).toMatch(/ПРОМПТ ДЛЯ/);
    expect(text).toContain("ПОДПИСЬ");
    expect(text).toContain("#бишкек");
    expect(text).toContain("Подключить");
  });

  test("рилс получает сценарий motion-графики по секундам, а не описание фото", () => {
    const text = formatPostBrief(post);
    expect(text).toContain("motion-graphics");
    expect(text).toContain("Сцена 1 (0-3 с)");
    expect(text).toContain("Сцена 3");
    expect(text).toContain(post.hook);
    expect(text).toContain(post.cta);
  });

  test("у ролика есть текст озвучки и настройки ElevenLabs", () => {
    const text = formatPostBrief(post);
    expect(text).toContain("ОЗВУЧКА");
    expect(text).toContain("eleven_multilingual_v2");
    expect(text).toContain("Stability: 45%");
    // На 12-15 секунд влезает примерно 40 слов — длиннее диктор просто не успеет.
    const script = text.split("ОЗВУЧКА")[1].split("Настройки")[0];
    expect(script.split(/\s+/).length).toBeLessThan(60);
  });

  test("у статичного поста озвучки нет — её нечем озвучивать", () => {
    const text = formatPostBrief({ ...post, format: "Пост" });
    expect(text).not.toContain("ОЗВУЧКА");
    expect(text).toContain("2. ПОДПИСЬ");
  });

  test("пост получает промпт для картинки, а не сценарий", () => {
    const text = formatPostBrief({ ...post, format: "Пост" });
    expect(text).toContain("Фотореалистичный кадр");
    expect(text).not.toContain("Сцена 1");
  });

  test("символы разметки обезврежены — сообщение не разваливается", () => {
    const text = formatPostBrief(post);
    expect(text).toContain("&lt;и&gt;");
    expect(text).toContain("&amp;");
  });

  test("вертикальному формату — вертикальный кадр, статичному — квадрат", () => {
    expect(formatPostBrief(post)).toContain("9:16");
    expect(formatPostBrief({ ...post, format: "Пост" })).toContain("квадратный");
  });

  test("текста в кадре мало: у картинки его нет совсем, у ролика — пара слов", () => {
    expect(formatPostBrief({ ...post, format: "Пост" })).toContain("БЕЗ текста");
    expect(formatPostBrief(post)).toContain("Текста на экране мало");
  });
});
