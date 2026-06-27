
create table if not exists public.salon_secrets (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  greenapi_instance text,
  greenapi_token text,
  owner_notify_phone text,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.salon_secrets to authenticated;
grant all on public.salon_secrets to service_role;

alter table public.salon_secrets enable row level security;

drop policy if exists "Salon admin reads secrets" on public.salon_secrets;
drop policy if exists "Salon admin inserts secrets" on public.salon_secrets;
drop policy if exists "Salon admin updates secrets" on public.salon_secrets;
drop policy if exists "Salon admin deletes secrets" on public.salon_secrets;
drop policy if exists "Super admin manages secrets" on public.salon_secrets;

create policy "Salon admin reads secrets" on public.salon_secrets
  for select to authenticated using (public.has_salon_access(auth.uid(), salon_id));
create policy "Salon admin inserts secrets" on public.salon_secrets
  for insert to authenticated with check (public.has_salon_access(auth.uid(), salon_id));
create policy "Salon admin updates secrets" on public.salon_secrets
  for update to authenticated using (public.has_salon_access(auth.uid(), salon_id)) with check (public.has_salon_access(auth.uid(), salon_id));
create policy "Salon admin deletes secrets" on public.salon_secrets
  for delete to authenticated using (public.has_salon_access(auth.uid(), salon_id));
create policy "Super admin manages secrets" on public.salon_secrets
  for all to authenticated using (public.has_role(auth.uid(), 'super_admin')) with check (public.has_role(auth.uid(), 'super_admin'));

insert into public.salon_secrets (salon_id, greenapi_instance, greenapi_token, owner_notify_phone)
select id, greenapi_instance, greenapi_token, owner_notify_phone
from public.salons
where greenapi_instance is not null or greenapi_token is not null or owner_notify_phone is not null
on conflict (salon_id) do update set
  greenapi_instance = excluded.greenapi_instance,
  greenapi_token = excluded.greenapi_token,
  owner_notify_phone = excluded.owner_notify_phone;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists salon_secrets_touch on public.salon_secrets;
create trigger salon_secrets_touch before update on public.salon_secrets
  for each row execute function public.touch_updated_at();

alter table public.salons drop column if exists greenapi_instance;
alter table public.salons drop column if exists greenapi_token;
alter table public.salons drop column if exists owner_notify_phone;

drop policy if exists "Anyone creates appointment" on public.appointments;
