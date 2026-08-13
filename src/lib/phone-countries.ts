/**
 * Country dialling data for the phone input.
 *
 * Pure data + pure helpers, deliberately free of React/DOM so the parsing,
 * formatting and validation rules can be unit-tested on their own
 * (see phone-input.test.ts).
 *
 * `mask` describes the *national* part only (without the dial code): every "X"
 * is one digit, everything else is a literal separator. The number of X's is
 * the maximum national length; `minDigits` covers the handful of countries
 * whose numbers are variable-length.
 *
 * Note: dial codes are NOT unique (+7 is Kazakhstan and Russia, +1 is the US
 * and Canada). Detection from an E.164 string therefore picks the first match
 * in list order — the component keeps the user's explicit pick in local state
 * so choosing "Россия" doesn't visibly snap back to "Казахстан".
 */

export interface PhoneCountry {
  /** ISO 3166-1 alpha-2 — the stable key for a country. */
  iso: string;
  /** Dial code including the leading "+". */
  dial: string;
  /** Russian name (the admin/booking UI is Russian-first). */
  name: string;
  /** English name — also used as a search alias. */
  nameEn: string;
  /** Flag emoji. */
  flag: string;
  /** National-part mask, "X" = one digit. */
  mask: string;
  /** Minimum national digits; defaults to the number of X's in `mask`. */
  minDigits?: number;
  /** Allowed leading digit of the national part, as a regex char class. */
  firstDigit?: string;
}

/**
 * CIS markets first (that's who books through Qabyl), then the rest roughly by
 * how often they show up in salon client lists.
 */
// One line per country keeps the table scannable and diffable, so it is exempt
// from Prettier's object-expansion rule.
// prettier-ignore
export const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso: "KG", dial: "+996", name: "Кыргызстан", nameEn: "Kyrgyzstan", flag: "🇰🇬", mask: "XXX XX-XX-XX", firstDigit: "[2-9]" },
  { iso: "KZ", dial: "+7",   name: "Казахстан", nameEn: "Kazakhstan", flag: "🇰🇿", mask: "XXX XXX-XX-XX" },
  { iso: "RU", dial: "+7",   name: "Россия", nameEn: "Russia", flag: "🇷🇺", mask: "XXX XXX-XX-XX" },
  { iso: "UZ", dial: "+998", name: "Узбекистан", nameEn: "Uzbekistan", flag: "🇺🇿", mask: "XX XXX-XX-XX" },
  { iso: "TJ", dial: "+992", name: "Таджикистан", nameEn: "Tajikistan", flag: "🇹🇯", mask: "XX XXX-XX-XX" },
  { iso: "TM", dial: "+993", name: "Туркменистан", nameEn: "Turkmenistan", flag: "🇹🇲", mask: "XX XX-XX-XX" },
  { iso: "AZ", dial: "+994", name: "Азербайджан", nameEn: "Azerbaijan", flag: "🇦🇿", mask: "XX XXX-XX-XX" },
  { iso: "AM", dial: "+374", name: "Армения", nameEn: "Armenia", flag: "🇦🇲", mask: "XX XX-XX-XX" },
  { iso: "GE", dial: "+995", name: "Грузия", nameEn: "Georgia", flag: "🇬🇪", mask: "XXX XX-XX-XX" },
  { iso: "BY", dial: "+375", name: "Беларусь", nameEn: "Belarus", flag: "🇧🇾", mask: "XX XXX-XX-XX" },
  { iso: "MD", dial: "+373", name: "Молдова", nameEn: "Moldova", flag: "🇲🇩", mask: "XX XXX-XXX" },
  { iso: "UA", dial: "+380", name: "Украина", nameEn: "Ukraine", flag: "🇺🇦", mask: "XX XXX-XX-XX" },
  { iso: "MN", dial: "+976", name: "Монголия", nameEn: "Mongolia", flag: "🇲🇳", mask: "XX XX-XX-XX" },
  { iso: "TR", dial: "+90",  name: "Турция", nameEn: "Turkey", flag: "🇹🇷", mask: "XXX XXX-XX-XX" },
  { iso: "AE", dial: "+971", name: "ОАЭ", nameEn: "United Arab Emirates", flag: "🇦🇪", mask: "XX XXX-XXXX" },
  { iso: "SA", dial: "+966", name: "Саудовская Аравия", nameEn: "Saudi Arabia", flag: "🇸🇦", mask: "XX XXX-XXXX" },
  { iso: "QA", dial: "+974", name: "Катар", nameEn: "Qatar", flag: "🇶🇦", mask: "XXXX-XXXX" },
  { iso: "KW", dial: "+965", name: "Кувейт", nameEn: "Kuwait", flag: "🇰🇼", mask: "XXXX-XXXX" },
  { iso: "IL", dial: "+972", name: "Израиль", nameEn: "Israel", flag: "🇮🇱", mask: "XX XXX-XXXX" },
  { iso: "EG", dial: "+20",  name: "Египет", nameEn: "Egypt", flag: "🇪🇬", mask: "XXX XXX-XXXX" },
  { iso: "IR", dial: "+98",  name: "Иран", nameEn: "Iran", flag: "🇮🇷", mask: "XXX XXX-XXXX" },
  { iso: "AF", dial: "+93",  name: "Афганистан", nameEn: "Afghanistan", flag: "🇦🇫", mask: "XX XXX-XXXX" },
  { iso: "PK", dial: "+92",  name: "Пакистан", nameEn: "Pakistan", flag: "🇵🇰", mask: "XXX XXX-XXXX" },
  { iso: "IN", dial: "+91",  name: "Индия", nameEn: "India", flag: "🇮🇳", mask: "XXXXX-XXXXX" },
  { iso: "CN", dial: "+86",  name: "Китай", nameEn: "China", flag: "🇨🇳", mask: "XXX XXXX-XXXX" },
  { iso: "KR", dial: "+82",  name: "Южная Корея", nameEn: "South Korea", flag: "🇰🇷", mask: "XX XXXX-XXXX", minDigits: 9 },
  { iso: "JP", dial: "+81",  name: "Япония", nameEn: "Japan", flag: "🇯🇵", mask: "XX XXXX-XXXX" },
  { iso: "TH", dial: "+66",  name: "Таиланд", nameEn: "Thailand", flag: "🇹🇭", mask: "XX XXX-XXXX" },
  { iso: "VN", dial: "+84",  name: "Вьетнам", nameEn: "Vietnam", flag: "🇻🇳", mask: "XXX XXX-XXX" },
  { iso: "MY", dial: "+60",  name: "Малайзия", nameEn: "Malaysia", flag: "🇲🇾", mask: "XX XXXX-XXXX", minDigits: 9 },
  { iso: "ID", dial: "+62",  name: "Индонезия", nameEn: "Indonesia", flag: "🇮🇩", mask: "XXX XXXX-XXXX", minDigits: 9 },
  { iso: "US", dial: "+1",   name: "США", nameEn: "United States", flag: "🇺🇸", mask: "XXX XXX-XXXX" },
  { iso: "CA", dial: "+1",   name: "Канада", nameEn: "Canada", flag: "🇨🇦", mask: "XXX XXX-XXXX" },
  { iso: "GB", dial: "+44",  name: "Великобритания", nameEn: "United Kingdom", flag: "🇬🇧", mask: "XXXX XXXXXX" },
  { iso: "DE", dial: "+49",  name: "Германия", nameEn: "Germany", flag: "🇩🇪", mask: "XXX XXXXXXXX", minDigits: 10 },
  { iso: "FR", dial: "+33",  name: "Франция", nameEn: "France", flag: "🇫🇷", mask: "X XX-XX-XX-XX" },
  { iso: "IT", dial: "+39",  name: "Италия", nameEn: "Italy", flag: "🇮🇹", mask: "XXX XXX-XXXX", minDigits: 9 },
  { iso: "ES", dial: "+34",  name: "Испания", nameEn: "Spain", flag: "🇪🇸", mask: "XXX XX-XX-XX" },
  { iso: "PL", dial: "+48",  name: "Польша", nameEn: "Poland", flag: "🇵🇱", mask: "XXX-XXX-XXX" },
  { iso: "CZ", dial: "+420", name: "Чехия", nameEn: "Czechia", flag: "🇨🇿", mask: "XXX XXX-XXX" },
  { iso: "LT", dial: "+370", name: "Литва", nameEn: "Lithuania", flag: "🇱🇹", mask: "XXX XXXXX" },
  { iso: "LV", dial: "+371", name: "Латвия", nameEn: "Latvia", flag: "🇱🇻", mask: "XXXX-XXXX" },
  { iso: "EE", dial: "+372", name: "Эстония", nameEn: "Estonia", flag: "🇪🇪", mask: "XXXX-XXXX", minDigits: 7 },
];

export const DEFAULT_COUNTRY_ISO = "KG";

/** Digits only, "+" and separators stripped. */
export function onlyDigits(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/** Maximum national-part length, i.e. how many "X" the mask has. */
export function maxDigitsOf(c: PhoneCountry): number {
  let n = 0;
  for (const ch of c.mask) if (ch === "X") n++;
  return n;
}

/** Minimum national-part length (equals the maximum unless declared otherwise). */
export function minDigitsOf(c: PhoneCountry): number {
  return c.minDigits ?? maxDigitsOf(c);
}

export function getCountry(iso: string): PhoneCountry | undefined {
  return PHONE_COUNTRIES.find((c) => c.iso === iso);
}

/**
 * Country for an E.164-ish string, by longest matching dial code. Returns
 * `undefined` when nothing matches — ties on the same dial code resolve to the
 * first entry in `PHONE_COUNTRIES`.
 */
export function detectCountry(value: string): PhoneCountry | undefined {
  const digits = onlyDigits(value);
  if (!digits) return undefined;
  let best: PhoneCountry | undefined;
  let bestLen = 0;
  for (const c of PHONE_COUNTRIES) {
    const dial = onlyDigits(c.dial);
    if (digits.startsWith(dial) && dial.length > bestLen) {
      best = c;
      bestLen = dial.length;
    }
  }
  return best;
}

/** National part of `value` for `country`, trimmed to that country's maximum. */
export function nationalDigits(value: string, country: PhoneCountry): string {
  const all = onlyDigits(value);
  const dial = onlyDigits(country.dial);
  const rest = all.startsWith(dial) ? all.slice(dial.length) : all;
  return rest.slice(0, maxDigitsOf(country));
}

/**
 * Apply a mask to the digits typed so far. Separators are only emitted while
 * digits remain, so a partially typed number never ends in a stray "-" or " ".
 */
export function formatNational(digits: string, mask: string): string {
  let out = "";
  let i = 0;
  for (const ch of mask) {
    if (i >= digits.length) break;
    if (ch === "X") out += digits[i++];
    else out += ch;
  }
  return out;
}

/** Placeholder for a country: its mask with every digit shown as 0. */
export function placeholderFor(country: PhoneCountry): string {
  return country.mask.replace(/X/g, "0");
}

/** Compose an E.164 string, or "" when there are no national digits. */
export function toE164(country: PhoneCountry, digits: string): string {
  const d = onlyDigits(digits).slice(0, maxDigitsOf(country));
  return d ? `${country.dial}${d}` : "";
}

/**
 * Total-digit bounds, shared by every layer that judges a phone number.
 *
 * The authority is the `validate_appointment_phone` DB trigger — it is the only
 * check a caller cannot skip, so everything upstream must agree with it or a
 * number gets rejected in one place and accepted in another. This constant
 * exists because those layers HAD drifted: wa-check used to demand 11 digits and
 * reported a valid 10-digit number as "not registered on WhatsApp", which the
 * public widget turns into a hard block with a factually wrong message.
 */
export const PHONE_DIGITS_MIN = 10;
export const PHONE_DIGITS_MAX = 15;

/**
 * Is `e164` a complete, plausible number for its country? Unknown dial codes
 * fall back to the same lenient 10–15 total digits the `validate_appointment_phone`
 * DB trigger enforces, so the widget never rejects what the backend accepts.
 */
export function isValidPhone(e164: string): boolean {
  const value = (e164 || "").trim();
  if (!value.startsWith("+")) return false;
  const digits = onlyDigits(value);
  const country = detectCountry(value);
  if (!country) return isPlausiblePhoneLength(digits);
  const national = digits.slice(onlyDigits(country.dial).length);
  if (national.length < minDigitsOf(country) || national.length > maxDigitsOf(country))
    return false;
  if (country.firstDigit && !new RegExp(`^${country.firstDigit}`).test(national)) return false;
  // The DB trigger rejects anything outside 10–15 digits regardless of country.
  return isPlausiblePhoneLength(digits);
}

/**
 * Digit-count gate, matching the DB trigger exactly. Takes a raw string so
 * callers that only ever see digits (the WhatsApp check, the agent's phone gate)
 * can use the same rule without importing the country table.
 */
export function isPlausiblePhoneLength(value: string): boolean {
  const digits = onlyDigits(value);
  return digits.length >= PHONE_DIGITS_MIN && digits.length <= PHONE_DIGITS_MAX;
}
