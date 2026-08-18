// "Контакты без Админа" — the numbers and Instagram accounts an owner listed so the assistant
// never talks to them: their own phone, staff, couriers, partners, the founder's test number.
//
// WHY THIS IS ITS OWN MODULE, and why it fails CLOSED.
//
// Every inbound channel used to inline the same three-line lookup, and each copy shared the same
// two holes:
//
//   1. `const { data } = await db…` swallows the error. A transient Supabase failure — or a query
//      that errors for any other reason — produced `data === null`, which reads exactly like "not
//      excluded". The assistant then answered a number the owner had explicitly silenced, and the
//      owner has no way to tell that from a bug in the exclusion list itself.
//   2. The comparison was a literal string match on the stored value. Anything that ever writes a
//      phone in another shape ("+996…", spaces, a pasted number) silently stops matching.
//
// Both are fixed here, once. The lookup loads the salon's whole list (a handful of rows, indexed
// on salon_id) and compares NORMALISED keys, and a lookup that fails is treated as "excluded".
//
// Fail-closed is the right default for exactly this decision: the cost of a false "excluded" is
// one message the assistant does not answer — visible in the admin panel, recoverable by a human
// reply. The cost of a false "not excluded" is the AI writing into the owner's personal chat,
// which is the single thing this feature exists to prevent. And when the database is unreachable
// the rest of the turn (storing the message, taking the lock, loading services) cannot work
// anyway, so bailing costs nothing that was going to succeed.

/** Result of one lookup. `ok: false` means we could not verify — callers must treat it as excluded. */
export type ExcludedContactsLookup = { ok: true; keys: Set<string> } | { ok: false; error: string };

/**
 * One comparable key per contact, so storage format drift cannot break a match.
 *
 * WhatsApp identities are phone numbers — digits only, no '+', no spaces, matching
 * normalizeChatIdToPhone. Instagram conversations are keyed `ig:<IGSID>` and keep their prefix.
 */
export function normalizeExcludedKey(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  if (s.startsWith("ig:")) return `ig:${s.slice(3).replace(/\D+/g, "")}`;
  return s.replace(/\D+/g, "");
}

/**
 * Load the salon's exclusion list.
 *
 * Returns every row rather than filtering in SQL on purpose: the list is per-salon and tiny, and
 * comparing in TypeScript is what lets normalisation apply to BOTH sides. A `.eq("phone", …)`
 * only ever matches bytes that are already identical.
 */
export async function loadExcludedContacts(
  db: any,
  salonId: string,
): Promise<ExcludedContactsLookup> {
  try {
    const { data, error } = await db
      .from("excluded_contacts")
      .select("phone")
      .eq("salon_id", salonId);
    if (error) return { ok: false, error: error.message ?? String(error) };
    const keys = new Set<string>();
    for (const row of (data ?? []) as Array<{ phone?: string | null }>) {
      const key = normalizeExcludedKey(row?.phone);
      if (key) keys.add(key);
    }
    return { ok: true, keys };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Is this contact silenced? A failed lookup counts as silenced — see the header. */
export function isExcludedByLookup(
  lookup: ExcludedContactsLookup,
  phone: string | null | undefined,
): boolean {
  if (!lookup.ok) return true;
  const key = normalizeExcludedKey(phone);
  if (!key) return false;
  return lookup.keys.has(key);
}

/**
 * The one call an inbound channel needs: "may the assistant answer this contact?"
 *
 * `errLog` is optional but should be passed by every webhook — a lookup failure silences a real
 * client, and that must be visible in the logs rather than looking like an idle salon.
 */
export async function isExcludedContact(
  db: any,
  salonId: string,
  phone: string | null | undefined,
  errLog?: (msg: string, ...rest: unknown[]) => void,
): Promise<boolean> {
  const lookup = await loadExcludedContacts(db, salonId);
  if (!lookup.ok) {
    errLog?.(
      `excluded_contacts lookup failed for salon ${salonId} — staying silent for this contact`,
      lookup.error,
    );
    return true;
  }
  return isExcludedByLookup(lookup, phone);
}
