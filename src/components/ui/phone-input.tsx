import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DEFAULT_COUNTRY_ISO,
  PHONE_COUNTRIES,
  detectCountry,
  formatNational,
  getCountry,
  maxDigitsOf,
  nationalDigits,
  onlyDigits,
  placeholderFor,
  toE164,
  type PhoneCountry,
} from "@/lib/phone-countries";

/**
 * Phone input with a country-code picker. The country determines the dial code
 * and the display mask; `onChange` always yields an E.164 string
 * ("+996555123456") or "" when the national part is empty.
 */
export interface PhoneInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "type"
> {
  value?: string;
  onChange?: (e164: string) => void;
  /** ISO code preselected when `value` carries no recognisable dial code. */
  defaultCountry?: string;
}

export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  (
    {
      value = "",
      onChange,
      className,
      defaultCountry = DEFAULT_COUNTRY_ISO,
      placeholder,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const { t } = useT();
    const [open, setOpen] = React.useState(false);
    // The country lives in local state because a dial code alone can't identify
    // one (+7 is both KZ and RU) — an explicit pick must survive re-renders.
    const [iso, setIso] = React.useState(
      () => detectCountry(value)?.iso ?? getCountry(defaultCountry)?.iso ?? DEFAULT_COUNTRY_ISO,
    );
    const country = getCountry(iso) ?? PHONE_COUNTRIES[0];

    // Follow the value when it's set from outside to a different dial code
    // (e.g. an edit dialog loading an existing client). Same dial code, no
    // change — that would undo a KZ/RU style pick on every keystroke.
    React.useEffect(() => {
      const detected = detectCountry(value);
      if (detected && detected.dial !== country.dial) setIso(detected.iso);
    }, [value, country.dial]);

    const digits = nationalDigits(value, country);
    const display = formatNational(digits, country.mask);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(toE164(country, onlyDigits(e.target.value)));
    };

    const selectCountry = (next: PhoneCountry) => {
      setIso(next.iso);
      setOpen(false);
      const kept = digits.slice(0, maxDigitsOf(next));
      onChange?.(toE164(next, kept));
    };

    return (
      <div
        className={cn(
          "flex items-stretch h-10 rounded-md border border-input bg-transparent text-base md:text-sm focus-within:ring-1 focus-within:ring-ring overflow-hidden",
          className,
        )}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={t("countrySelect")}
              className="flex items-center gap-1 px-3 bg-muted text-muted-foreground select-none border-r border-input outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span aria-hidden className="text-base leading-none">
                {country.flag}
              </span>
              <span className="tabular-nums">{country.dial}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(20rem,calc(100vw-2rem))] p-0"
            // Keep focus on the search box instead of bouncing back to the input.
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <Command
              filter={(itemValue, search) => {
                const q = search.trim().toLowerCase().replace(/^\+/, "");
                if (!q) return 1;
                return itemValue.toLowerCase().includes(q) ? 1 : 0;
              }}
            >
              <CommandInput placeholder={t("countrySearch")} />
              <CommandList className="max-h-64">
                <CommandEmpty>{t("countryNotFound")}</CommandEmpty>
                <CommandGroup>
                  {PHONE_COUNTRIES.map((c) => (
                    <CommandItem
                      key={c.iso}
                      // Searchable haystack: Russian and English names, the ISO
                      // code, and the dial code with and without its "+".
                      value={`${c.name} ${c.nameEn} ${c.iso} ${c.dial} ${c.dial.slice(1)}`}
                      onSelect={() => selectCountry(c)}
                      className="gap-2"
                    >
                      <span aria-hidden className="text-base leading-none">
                        {c.flag}
                      </span>
                      <span className="flex-1 truncate">{c.name}</span>
                      <span className="text-muted-foreground tabular-nums">{c.dial}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <input
          ref={ref}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          disabled={disabled}
          className="flex-1 min-w-0 bg-transparent px-3 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={display}
          onChange={handleChange}
          placeholder={placeholder ?? placeholderFor(country)}
          {...rest}
        />
      </div>
    );
  },
);
PhoneInput.displayName = "PhoneInput";
