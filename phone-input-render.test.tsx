// Render-level companion to phone-input.test.ts: the pure helpers are covered
// there, this file pins what the client actually sees in the booking widget —
// the dial-code chip and the unparenthesised mask.
// Run: bun test phone-input-render.test.tsx
import { test, expect, describe } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { PhoneInput } from "@/components/ui/phone-input";

function render(props: React.ComponentProps<typeof PhoneInput>) {
  return renderToString(React.createElement(PhoneInput, { onChange: () => {}, ...props }));
}

/** The `value=""` attribute React emits for the inner <input>. */
function inputValue(html: string): string {
  return html.match(/value="([^"]*)"\/>/)?.[1] ?? "";
}

function placeholder(html: string): string {
  return html.match(/placeholder="([^"]*)"/)?.[1] ?? "";
}

describe("PhoneInput rendering", () => {
  test("shows the number without parentheses", () => {
    const html = render({ value: "+996707111726" });
    expect(inputValue(html)).toBe("707 11-17-26");
    expect(html).not.toContain("(707)");
  });

  test("no rendered output contains a parenthesised group", () => {
    for (const value of ["+996707111726", "+79991234567", "+998901234567", "+14155550123"]) {
      const html = render({ value });
      expect(inputValue(html)).not.toMatch(/[()]/);
      expect(placeholder(html)).not.toMatch(/[()]/);
    }
  });

  test("the dial code chip follows the number's country code", () => {
    expect(render({ value: "+996707111726" })).toContain(">+996<");
    expect(render({ value: "+79991234567" })).toContain(">+7<");
    expect(render({ value: "+992901234567" })).toContain(">+992<");
    expect(render({ value: "+905321234567" })).toContain(">+90<");
  });

  test("an empty field defaults to Kyrgyzstan with a shape hint", () => {
    const html = render({ value: "" });
    expect(html).toContain(">+996<");
    expect(inputValue(html)).toBe("");
    expect(placeholder(html)).toBe("000 00-00-00");
  });

  test("defaultCountry preselects another code for an empty field", () => {
    const html = render({ value: "", defaultCountry: "KZ" });
    expect(html).toContain(">+7<");
    expect(placeholder(html)).toBe("000 000-00-00");
  });

  test("the country chip is a labelled button, not a dead prefix", () => {
    const html = render({ value: "" });
    expect(html).toContain('type="button"');
    expect(html).toContain("Код страны");
  });

  test("partial input renders without a trailing separator", () => {
    expect(inputValue(render({ value: "+996707" }))).toBe("707");
    expect(inputValue(render({ value: "+9967071" }))).toBe("707 1");
  });
});
