// Светлая и тёмная тема.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Токены тёмной темы лежали в styles.css с самого начала, с
// комментарием о том, как в ней меняются роли цветов, — но класс `dark` не ставил никто. То
// есть тема была написана, продумана и физически невключаема: код, который нельзя проверить и
// который тихо устаревает с каждым новым экраном. Здесь она наконец включается.
//
// ТРИ СОСТОЯНИЯ, А НЕ ДВА. «Системная» — это не синоним светлой: человек, у которого телефон
// ночью сам уходит в тёмную, ждёт того же и от приложения. Поэтому выбор хранится как
// light | dark | system, и system слушает системную настройку в реальном времени.
//
// ПОЧЕМУ СКРИПТ В ШАПКЕ. Если ставить класс из React, страница успевает отрисоваться светлой
// и только потом темнеет — вспышка белого в лицо тому, кто открыл кабинет ночью. Скрипт ниже
// встроен в <head> и выполняется до первой отрисовки.

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_KEY = "qabyl.theme";

/** Цвет системной шапки браузера. Должен совпадать с --background соответствующей темы. */
const BAR_LIGHT = "#fbf9fa";
const BAR_DARK = "#231f21";

/**
 * Скрипт, встраиваемый в <head> как есть.
 *
 * Пишется строкой, а не импортируемой функцией, нарочно: он должен выполниться до загрузки
 * любого бандла. Всё внутри обёрнуто в try — заблокированный localStorage (приватный режим,
 * запрет сторонних данных) не имеет права уронить страницу целиком.
 */
export const THEME_BOOTSTRAP = `(function(){try{
var k=${JSON.stringify(THEME_KEY)};
var c=localStorage.getItem(k)||"system";
var d=c==="dark"||(c==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark",d);
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",d?${JSON.stringify(BAR_DARK)}:${JSON.stringify(BAR_LIGHT)});
}catch(e){}})();`;

export function readThemeChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Что в итоге видно на экране — с учётом системной настройки. */
export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paint(choice: ThemeChoice) {
  const dark = resolveTheme(choice) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? BAR_DARK : BAR_LIGHT);
}

export function applyThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Выбор не сохранится до следующего захода, но текущую сессию применить можно.
  }
  paint(choice);
  notify(choice);
}

// Подписчики — чтобы переключатель в «Аккаунте» знал текущий выбор, даже если его сменили в
// соседней вкладке. Стор крошечный и живёт здесь же: заводить контекст ради одного значения
// дороже, чем оно стоит.
const listeners = new Set<(c: ThemeChoice) => void>();
function notify(c: ThemeChoice) {
  for (const l of listeners) l(c);
}

export function subscribeTheme(listener: (c: ThemeChoice) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let watching = false;

/**
 * Следить за системной настройкой, пока выбор — «как в системе».
 *
 * Вызывается один раз из кабинета. Без этого телефон, ушедший в тёмную тему по расписанию,
 * перекрасит всё, кроме открытой вкладки Qabyl.
 */
export function watchSystemTheme() {
  if (watching || typeof window === "undefined" || !window.matchMedia) return;
  watching = true;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (readThemeChoice() === "system") paint("system");
  };
  mq.addEventListener?.("change", onChange);
  // Тема, выбранная в соседней вкладке, должна доехать и сюда.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY) return;
    const c = readThemeChoice();
    paint(c);
    notify(c);
  });
}
