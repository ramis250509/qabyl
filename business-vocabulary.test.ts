import { describe, expect, test } from "bun:test";
import { vocabularyFor } from "./src/lib/business-vocabulary";

describe("business vocabulary", () => {
  test("medical vertical never exposes salon/master/client nouns", () => {
    const v = vocabularyFor("medical");
    expect(v.businessPossessive).toBe("Моя клиника");
    expect(v.specialists).toBe("Специалисты");
    expect(v.clients).toBe("Пациенты");
  });

  test("medical-adjacent verticals share clinical vocabulary", () => {
    expect(vocabularyFor("dental")).toEqual(vocabularyFor("medical"));
    expect(vocabularyFor("cosmetology")).toEqual(vocabularyFor("medical"));
  });

  test("unknown and beauty keep the existing product language", () => {
    expect(vocabularyFor("unknown").businessPossessive).toBe("Мой салон");
    expect(vocabularyFor("beauty").specialists).toBe("Мастера");
  });
});
