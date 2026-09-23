# Photo regression (isolated)

No production database or customer conversations are touched. Local uploads live in
`images/` (git-ignored). Do not use client photos without consent.

1. Configure photo rules for each range-priced service in **AI Assistant → Оценка цены по фото**.
   Save, then click **Скачать правила для теста фото**.
2. Run `bun run qa:photo --annotate` and open http://127.0.0.1:4177. Import that export,
   upload a photo, choose a service and expected visible attributes from the dropdowns.
   "Не видно / не уверен" marks uncertainty; expected price is computed automatically.
3. After adding fixtures, run `bun run qa:photo`. It reports per-criterion classification,
   price correctness, and uncertainty handling. This command requires a working `GEMINI_API_KEY`.
   At most 40 photos are sent per invocation; no request is made with an empty corpus.
   A shared persistent ledger (`qa/api-budget-local.json`) reserves $0.05 per Gemini attempt
   across this runner and the dialogue QA suite, and stops before $2.99 reserved.
   This is a conservative test-runner guard, not a Google billing guarantee: other API traffic
   and delayed spend-cap processing are outside this process.

The exported catalog and `cases.json` are fixtures. Keep them free of names, phone numbers,
or other personal data. The photo classifier returns attribute IDs only; the same deterministic
price calculator is used by the live assistant and regression.
