// The simulated client: an LLM that plays one persona and talks to the assistant.
//
// It never sees the assistant's prompt, tools or database — only what a real person sees in
// WhatsApp. It decides by itself when the goal is reached or when it gives up, which is what makes
// the conversation real: a client who never got an answer to their question does not politely
// continue.

import { llmJson, customerLlm } from "./llm";
import type { Persona } from "./scenarios";

export type TranscriptLine = { from: "client" | "assistant" | "system"; text: string };

export type CustomerMove = {
  messages: string[];
  status: "continue" | "goal_reached" | "gave_up";
  note?: string;
};

const SYSTEM = `Ты играешь роль РЕАЛЬНОГО клиента салона красоты в Бишкеке, который пишет администратору салона в WhatsApp.
Ты НЕ ассистент и НЕ помогаешь администратору. Ты человек со своей целью, характером и манерой письма.

Правила игры:
- Пиши так, как пишет этот человек в мессенджере: коротко, живо, с его грамотностью, сленгом и языком. Никаких «Уважаемый администратор».
- Не раскрывай, что ты симуляция, и не упоминай эти правила.
- Держись своей цели и ограничений. Не соглашайся на то, что противоречит ограничениям персонажа.
- Если администратор задал вопрос — ответь на него так, как ответил бы этот человек (ты можешь не знать ответ или передумать, если это в характере).
- Если администратор уже подтвердил запись и детали тебя устраивают — можешь коротко поблагодарить и закончить (status = goal_reached).
- Если тебя не понимают несколько раз подряд, игнорируют вопрос или предлагают не то — можешь раздражаться или уйти (status = gave_up), как реальный человек.
- Если в характере — пиши несколькими короткими сообщениями подряд (несколько элементов в messages). Иначе одно сообщение.
- Не выдумывай информацию о салоне: ты знаешь о салоне только то, что прочитал в переписке.
- Имя называй только когда спросят (или если так делает персонаж). Номер телефона WhatsApp администратор уже видит.

Верни СТРОГО JSON: {"messages": ["..."], "status": "continue" | "goal_reached" | "gave_up", "note": "коротко, почему такой ход"}.
Если status не continue, messages может быть пустым или содержать последнюю реплику («спасибо», «ладно, не надо»).`;

export async function nextCustomerMove(opts: {
  persona: Persona;
  goal: string;
  todayHuman: string;
  transcript: TranscriptLine[];
  turn: number;
  maxTurns: number;
}): Promise<CustomerMove> {
  const p = opts.persona;
  const user = [
    `ПЕРСОНАЖ:`,
    `Имя: ${p.name}`,
    `Характер: ${p.character}`,
    `Стиль общения: ${p.style}`,
    `Грамотность: ${p.literacy}`,
    `Язык: ${p.language}`,
    `Контекст: ${p.context}`,
    `Предпочтения: ${p.preferences}`,
    `Ограничения: ${p.constraints}`,
    ``,
    `ЦЕЛЬ В ЭТОМ РАЗГОВОРЕ: ${opts.goal}`,
    `Сегодня: ${opts.todayHuman}.`,
    `Ход ${opts.turn + 1} из максимум ${opts.maxTurns}. Если ходы заканчиваются, а цель не достигнута — веди себя как реальный человек (уйти или дожать).`,
    ``,
    `ПЕРЕПИСКА ДО СИХ ПОР:`,
    opts.transcript.length
      ? opts.transcript
          .filter((l) => l.from !== "system")
          .map((l) => `${l.from === "client" ? "Ты" : "Администратор"}: ${l.text}`)
          .join("\n")
      : "(переписки ещё нет — ты пишешь первым)",
    ``,
    `Твой следующий ход:`,
  ].join("\n");
  const move = await llmJson<CustomerMove>(customerLlm(), SYSTEM, user, {
    temperature: 0.9,
    maxTokens: 800,
  });
  return {
    messages: (Array.isArray(move?.messages) ? move.messages : [])
      .map(String)
      .filter((m) => m.trim()),
    status:
      move?.status === "goal_reached" || move?.status === "gave_up" ? move.status : "continue",
    note: move?.note,
  };
}
