import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Универсальный input телефона для KG: фиксированный префикс +996,
 * маска отображения "+996 (XXX) XX-XX-XX". В onChange/значение всегда
 * возвращается E.164-строка "+996XXXXXXXXX" (или пустая строка).
 */
export interface PhoneInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value?: string;
  onChange?: (e164: string) => void;
  prefix?: string; // default +996
  digitsLength?: number; // default 9
}

function formatKG(digits: string) {
  // digits up to 9: XXX XX XX XX → "(XXX) XX-XX-XX"
  const d = digits.slice(0, 9);
  const p1 = d.slice(0, 3);
  const p2 = d.slice(3, 5);
  const p3 = d.slice(5, 7);
  const p4 = d.slice(7, 9);
  let out = "";
  if (p1) out += `(${p1}`;
  if (p1.length === 3) out += ")";
  if (p2) out += ` ${p2}`;
  if (p3) out += `-${p3}`;
  if (p4) out += `-${p4}`;
  return out;
}

export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ value = "", onChange, className, prefix = "+996", digitsLength = 9, placeholder, ...rest }, ref) => {
    const rawDigits = React.useMemo(() => {
      const s = (value || "").replace(/\D/g, "");
      const pfx = prefix.replace(/\D/g, "");
      const stripped = s.startsWith(pfx) ? s.slice(pfx.length) : s;
      return stripped.slice(0, digitsLength);
    }, [value, prefix, digitsLength]);

    const display = formatKG(rawDigits);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const digits = e.target.value.replace(/\D/g, "").slice(0, digitsLength);
      onChange?.(digits ? `${prefix}${digits}` : "");
    };

    return (
      <div
        className={cn(
          "flex items-stretch h-10 rounded-md border border-input bg-transparent text-base md:text-sm focus-within:ring-1 focus-within:ring-ring overflow-hidden",
          className,
        )}
      >
        <span className="px-3 flex items-center bg-muted text-muted-foreground select-none border-r border-input">
          {prefix}
        </span>
        <input
          ref={ref}
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          className="flex-1 bg-transparent px-3 outline-none placeholder:text-muted-foreground"
          value={display}
          onChange={handleChange}
          placeholder={placeholder ?? "(555) 12-34-56"}
          {...rest}
        />
      </div>
    );
  },
);
PhoneInput.displayName = "PhoneInput";

/** Проверка, что номер заполнен полностью (E.164 KG). */
export function isValidKGPhone(e164: string, prefix = "+996", digitsLength = 9) {
  const re = new RegExp(`^\\${prefix}\\d{${digitsLength}}$`);
  return re.test(e164);
}
