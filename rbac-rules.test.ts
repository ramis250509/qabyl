// Регрессия: захват чужого аккаунта через «выдать пароль сотруднику» (аудит 13.09.2026).
//
// Сценарий атаки, который был рабочим: зарегистрироваться → создать свой салон → пригласить
// почту жертвы (inviteEmployee привязывает существующий аккаунт) → resetEmployeePassword
// возвращал новый пароль жертвы, потому что проверял роли только в салоне атакующего.
//
// Run: bun test rbac-rules
import { test, expect, describe } from "bun:test";
import { passwordResetDenial } from "@/lib/rbac-rules";

const MY = "salon-mine";
const OTHER = "salon-other";

describe("passwordResetDenial", () => {
  test("мастер только этого салона — пароль выдать можно", () => {
    expect(passwordResetDenial("owner", MY, [{ role: "master", salon_id: MY }])).toBeNull();
    expect(passwordResetDenial("manager", MY, [{ role: "master", salon_id: MY }])).toBeNull();
  });

  test("человек без роли в салоне — отказ", () => {
    expect(passwordResetDenial("owner", MY, [])).not.toBeNull();
    expect(passwordResetDenial("owner", MY, [{ role: "master", salon_id: OTHER }])).not.toBeNull();
  });

  test("АТАКА: владелец платформы, «приглашённый» в чужой салон — отказ", () => {
    const victim = [
      { role: "super_admin", salon_id: null },
      { role: "master", salon_id: MY },
    ];
    expect(passwordResetDenial("owner", MY, victim)).not.toBeNull();
  });

  test("АТАКА: владелец другого салона, «приглашённый» мастером — отказ", () => {
    const victim = [
      { role: "salon_admin", salon_id: OTHER },
      { role: "master", salon_id: MY },
    ];
    expect(passwordResetDenial("owner", MY, victim)).not.toBeNull();
  });

  test("администратор не меняет пароль владельцу своего салона", () => {
    expect(
      passwordResetDenial("manager", MY, [{ role: "salon_admin", salon_id: MY }]),
    ).not.toBeNull();
  });
});
