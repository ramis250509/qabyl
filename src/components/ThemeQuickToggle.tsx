import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyThemeChoice, readThemeChoice, resolveTheme, subscribeTheme } from "@/lib/theme";

export function ThemeQuickToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const sync = () => setDark(resolveTheme(readThemeChoice()) === "dark");
    sync();
    return subscribeTheme(sync);
  }, []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-9 w-9 shrink-0"
      onClick={() => applyThemeChoice(dark ? "light" : "dark")}
      aria-label={dark ? "Включить светлую тему" : "Включить тёмную тему"}
      title={dark ? "Светлая тема" : "Тёмная тема"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
