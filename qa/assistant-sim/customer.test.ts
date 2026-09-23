import { expect, test } from "bun:test";
import { normalizeCustomerMove } from "./customer";

test("booking customer does not claim success before answering explicit confirmation", () => {
  const move = normalizeCustomerMove(
    { status: "goal_reached", messages: [] },
    [
      {
        from: "assistant",
        text: "На четверг в 14:00 к Айгуль, 800 сом. Всё верно? Подтвердите запись.",
      },
    ],
    true,
  );
  expect(move.status).toBe("continue");
  expect(move.messages).toEqual(["Да, всё верно, подтверждаю."]);
});

test("customer may still leave instead of confirming", () => {
  const move = normalizeCustomerMove(
    { status: "gave_up", messages: [] },
    [{ from: "assistant", text: "Всё верно? Подтвердите запись." }],
    true,
  );
  expect(move.status).toBe("gave_up");
});
