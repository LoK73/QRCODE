-- Le funzioni dei permessi passano nello schema "private", che Supabase non pubblica
-- nell'API REST: restano utilizzabili dalle regole RLS e dalla dashboard (via SQL), ma
-- nessuno può richiamarle da internet. Le regole RLS continuano a funzionare perché
-- puntano alle funzioni, non al loro nome.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter function public.is_agency() set schema private;
alter function public.is_agency_admin() set schema private;
alter function public.can_see_client(uuid) set schema private;
alter function public.can_manage_client(uuid) set schema private;
alter function public.can_decide_client(uuid) set schema private;
alter function public.set_site_secret(uuid, text) set schema private;
alter function public.has_site_secret(uuid) set schema private;
alter function public.forget_linked_chat() set schema private;
alter function public.handle_new_user() set schema private;
alter function public.keep_client_id() set schema private;

-- I corpi che richiamano altre funzioni dei permessi vanno aggiornati al nuovo schema.
create or replace function private.can_see_client(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_agency() or exists (
    select 1 from memberships where user_id = auth.uid() and client_id = cid
  );
$$;

create or replace function private.can_manage_client(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_agency() or exists (
    select 1 from memberships where user_id = auth.uid() and client_id = cid and role = 'operatore_agenzia'
  );
$$;

create or replace function private.can_decide_client(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.can_manage_client(cid) or exists (
    select 1
    from memberships m join clients c on c.id = m.client_id
    where m.user_id = auth.uid() and m.client_id = cid
      and m.role = 'responsabile_cliente' and c.approval_rule = 'cliente'
  );
$$;

create or replace function private.set_site_secret(cid uuid, encrypted text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.can_manage_client(cid) then
    raise exception 'Non hai i permessi per modificare questo cliente' using errcode = '42501';
  end if;
  if encrypted is null or encrypted not like 'v1:%' then
    raise exception 'Formato della credenziale non valido';
  end if;
  insert into client_secrets (client_id, wp_app_password_enc, updated_at)
  values (cid, encrypted, now())
  on conflict (client_id) do update set wp_app_password_enc = excluded.wp_app_password_enc, updated_at = now();
end;
$$;

create or replace function private.has_site_secret(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.can_manage_client(cid) and exists (select 1 from client_secrets where client_id = cid);
$$;

-- Solo gli utenti collegati possono usarle; le funzioni dei trigger non servono a nessuno.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.is_agency(), private.is_agency_admin(), private.can_see_client(uuid),
  private.can_manage_client(uuid), private.can_decide_client(uuid),
  private.set_site_secret(uuid, text), private.has_site_secret(uuid)
to authenticated;
