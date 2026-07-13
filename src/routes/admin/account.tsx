import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { AtSign, KeyRound } from "lucide-react";
import { updateMyLogin, updateMyPassword } from "@/lib/account.functions";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin/account")({
  head: () => ({ meta: [{ title: "Мой аккаунт — Qabyl" }] }),
  component: AccountPage,
});

function AccountPage() {
  const { user, loading } = useAuth();

  // Смена логина (email)
  const [newEmail, setNewEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSaving, setLoginSaving] = useState(false);

  // Смена пароля
  const [curPassword, setCurPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  if (loading) return <FullScreenLoader />;
  const currentEmail = user?.email ?? "—";

  async function saveLogin() {
    if (!newEmail.trim()) return toast.error("Укажите новый email");
    if (!loginPassword) return toast.error("Введите текущий пароль для подтверждения");
    setLoginSaving(true);
    try {
      const res = await updateMyLogin({
        data: { newEmail: newEmail.trim(), currentPassword: loginPassword },
      });
      // Обновляем JWT, чтобы UI (и последующие действия) сразу видели новый email.
      await supabase.auth.refreshSession().catch(() => {});
      toast.success(`Логин изменён на ${res.email}. Используйте его при следующем входе.`);
      setNewEmail("");
      setLoginPassword("");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось изменить логин");
    } finally {
      setLoginSaving(false);
    }
  }

  async function savePassword() {
    if (!curPassword) return toast.error("Введите текущий пароль");
    if (newPassword.length < 8) return toast.error("Новый пароль должен быть не короче 8 символов");
    if (newPassword !== confirmPassword) return toast.error("Пароли не совпадают");
    setPwSaving(true);
    try {
      await updateMyPassword({
        data: { currentPassword: curPassword, newPassword },
      });
      toast.success("Пароль изменён");
      setCurPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось изменить пароль");
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Мой аккаунт</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Здесь можно сменить логин (email) и пароль для входа в систему.
        </p>
      </div>

      {/* Логин */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <AtSign className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">Логин (email)</h3>
            <p className="text-sm text-muted-foreground">
              Текущий логин: <span className="font-medium text-foreground">{currentEmail}</span>
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Новый логин (email)</Label>
          <Input
            type="email"
            autoComplete="username"
            placeholder="new@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Текущий пароль</Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Нужен для подтверждения, что это вы.</p>
        </div>
        <div className="flex justify-end">
          <Button onClick={saveLogin} disabled={loginSaving}>
            {loginSaving ? "Сохранение..." : "Сменить логин"}
          </Button>
        </div>
      </Card>

      {/* Пароль */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">Пароль</h3>
            <p className="text-sm text-muted-foreground">Минимум 8 символов.</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Текущий пароль</Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={curPassword}
            onChange={(e) => setCurPassword(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Новый пароль</Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Повторите новый пароль</Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={savePassword} disabled={pwSaving}>
            {pwSaving ? "Сохранение..." : "Сменить пароль"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
