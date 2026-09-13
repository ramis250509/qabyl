// Ошибка на языке владельца салона.
//
// ЗАЧЕМ. Почти каждый обработчик в кабинете заканчивается на `toast.error(error.message)`, а
// message приходит от Postgres, Supabase или нашей же серверной функции — и написан он для
// разработчика и по-английски. Владелица салона видела поверх русского интерфейса строки вроде
// «Only owner (salon_admin) can change staff isolation», «duplicate key value violates unique
// constraint» или «Forbidden», и у неё оставался один вариант действий: звонить в поддержку.
//
// ПРАВИЛО ПЕРЕВОДА. Сообщение должно отвечать на вопрос «что мне теперь делать», а не «что
// случилось внутри». Если делать нечего — честно сказать, что это наша поломка, а не её ошибка.
//
// ЧЕГО ЗДЕСЬ НЕТ. Словаря на все случаи: чужие тексты меняются, и гнаться за ними бессмысленно.
// Незнакомую ошибку отдаём как есть — это хуже, чем перевод, но лучше, чем «что-то пошло не так»,
// после которого в поддержку приходят без единой подробности.

const RULES: { match: RegExp; text: string }[] = [
  // ── Права ────────────────────────────────────────────────────────────────
  {
    match: /only owner|salon_admin can|forbidden|not authorized|permission denied|insufficient/i,
    text: "Это может сделать только владелец салона.",
  },
  { match: /row-level security|violates row-level/i, text: "Нет доступа к этим данным." },
  { match: /jwt|token .*expired|invalid claim/i, text: "Сессия истекла — войдите заново." },

  // ── Данные ───────────────────────────────────────────────────────────────
  {
    match: /duplicate key|already exists|unique constraint/i,
    text: "Такая запись уже есть.",
  },
  {
    match: /violates foreign key|still referenced/i,
    text: "Сначала удалите или отвяжите связанные записи.",
  },
  { match: /not-null constraint|null value in column/i, text: "Заполните все обязательные поля." },
  { match: /invalid input syntax|invalid uuid/i, text: "Проверьте, правильно ли заполнены поля." },
  { match: /value too long/i, text: "Слишком длинный текст — сократите." },

  // ── Аккаунты ─────────────────────────────────────────────────────────────
  {
    match: /user already registered|already been registered/i,
    text: "Такой email уже зарегистрирован.",
  },
  { match: /invalid login credentials/i, text: "Неверный email или пароль." },
  { match: /email not confirmed/i, text: "Подтвердите email — письмо уже на почте." },
  {
    match: /password should be at least|weak password/i,
    text: "Пароль слишком короткий — нужно минимум 8 символов.",
  },
  {
    // «Подождите минуту» здесь было неправдой: почтовый лимит у Supabase часовой, и человек,
    // подождавший минуту, упирался в то же самое и решал, что сломано.
    match: /for security purposes|after \d+ seconds?/i,
    text: "Уже отправлено. Повторить можно через минуту.",
  },
  {
    match: /rate limit|too many requests/i,
    text: "Слишком много попыток за последний час. Попробуйте позже.",
  },
  { match: /unable to validate email/i, text: "Проверьте, правильно ли написан email." },

  // ── Запись (create_appointment / reschedule_appointment_v2) ──────────────
  // Эти тексты видит не только владелец, но и КЛИЕНТ на странице записи: английская строка из
  // Postgres на экране «Подтвердить запись» выглядит как сломанный сайт, и человек уходит звонить.
  {
    match: /salon_billing_suspended/i,
    text: "Онлайн-запись в этом салоне временно недоступна. Позвоните или напишите салону напрямую.",
  },
  {
    match:
      /no longer available|conflicting key value|exclusion constraint|appointments_no_overlap/i,
    text: "Это время только что заняли — выберите другое.",
  },
  {
    match: /cannot (book|reschedule) (in|to) the past/i,
    text: "Это время уже прошло — выберите другое.",
  },
  {
    match: /master cannot perform this service|master does not offer this service/i,
    text: "Этот мастер не делает выбранную услугу — выберите другого мастера.",
  },
  {
    match: /master does not work at this branch/i,
    text: "Этот мастер работает в другом филиале.",
  },
  { match: /service not found/i, text: "Услуга больше недоступна — обновите страницу." },
  { match: /invalid client phone/i, text: "Проверьте номер телефона." },
  { match: /invalid client name/i, text: "Укажите имя." },
  {
    match: /only confirmed appointments can be rescheduled/i,
    text: "Эту запись уже нельзя перенести — она отменена или завершена.",
  },
  { match: /price override/i, text: "Цена вне допустимого диапазона для этой услуги." },
  { match: /hold minutes out of range/i, text: "Некорректное время удержания слота." },

  // ── Наши серверные функции ───────────────────────────────────────────────
  { match: /master not found/i, text: "Мастер не найден — обновите страницу." },
  {
    match: /master belongs to a different salon/i,
    text: "Этот мастер работает в другом салоне.",
  },
  {
    match: /already linked to another user/i,
    text: "К этому мастеру уже привязан другой аккаунт.",
  },
  { match: /branchid required/i, text: "Выберите точку — мастер работает в конкретной точке." },

  // ── Сеть ─────────────────────────────────────────────────────────────────
  {
    match: /failed to fetch|networkerror|econnrefused|timeout|timed out/i,
    text: "Не получилось связаться с сервером. Проверьте интернет и попробуйте ещё раз.",
  },
  {
    match: /service unavailable|503|502|bad gateway/i,
    text: "Сервер занят — попробуйте через минуту.",
  },
];

/**
 * @param fallback Что сказать, если сообщения нет вовсе. Пишите его от действия:
 *   «Не удалось сохранить услугу», а не «Ошибка».
 */
export function humanError(err: unknown, fallback = "Не получилось. Попробуйте ещё раз."): string {
  const raw = typeof err === "string" ? err : ((err as { message?: string } | null)?.message ?? "");
  if (!raw.trim()) return fallback;
  for (const r of RULES) if (r.match.test(raw)) return r.text;
  // Строка без единой кириллической буквы почти наверняка написана не для владельца салона.
  // Показать её всё равно полезнее, чем скрыть: с ней в поддержке хотя бы есть за что зацепиться.
  return raw;
}
