export function LegalLinks() {
  return (
    <nav
      aria-label="Сервис и документы"
      className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground"
    >
      <a className="underline" href="/">
        Qabyl
      </a>
      <a className="underline" href="/pricing">
        Тарифы
      </a>
      <a className="underline" href="/terms">
        Условия использования
      </a>
      <a className="underline" href="/privacy">
        Конфиденциальность
      </a>
      <a className="underline" href="/payments">
        Оплата и возврат
      </a>
      <a className="underline" href="mailto:support@qabyl.com">
        Поддержка
      </a>
    </nav>
  );
}
