-- Анонимный пользователь не должен даже иметь права вызвать create_salon_for_owner.
--
-- КАК НАШЛОСЬ. После наката 20260909090000 проверка has_function_privilege показала: у роли
-- `anon` есть EXECUTE на функцию, хотя в миграции стоит `revoke all ... from public`. Причина в
-- Supabase: default privileges схемы public выдают EXECUTE на новые функции ролям anon и
-- authenticated НАПРЯМУЮ, а не через PUBLIC, и отзыв у PUBLIC их не касается.
--
-- ОПАСНО ЛИ БЫЛО. Нет: первой строкой функция проверяет auth.uid() и без авторизации отказывает.
-- Но SECURITY DEFINER-функция, которая пишет в user_roles, не должна полагаться на одну проверку
-- внутри — право на вызов у неавторизованного отзываем явно.

revoke execute on function public.create_salon_for_owner(text, text, text, text) from anon;
