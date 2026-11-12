-- Ciò che serve alla dashboard oltre allo schema di base.

-- Chat WhatsApp da cui il bot riceve messaggi ma che non sono collegate a nessun cliente:
-- la dashboard le propone quando si collega un gruppo, senza dover copiare l'identificativo a mano.
create table public.chat_non_collegate (
  chat_id text primary key,
  chat_type text not null default 'group',
  last_sender text,
  last_text text,
  messages integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.chat_non_collegate enable row level security;
create policy chat_non_collegate_select on public.chat_non_collegate for select to authenticated using (public.is_agency());
create policy chat_non_collegate_delete on public.chat_non_collegate for delete to authenticated using (public.is_agency());
grant select, delete on public.chat_non_collegate to authenticated;
grant all on public.chat_non_collegate to service_role;

-- Una chat collegata a un cliente esce dall'elenco delle non collegate.
create function public.forget_linked_chat() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from chat_non_collegate where chat_id = new.chat_id;
  return new;
end;
$$;
create trigger client_channels_forget after insert on public.client_channels
  for each row execute function public.forget_linked_chat();

-- Salva la password applicazione di WordPress (già cifrata dal server della dashboard).
-- Gli utenti non hanno alcun accesso alla tabella dei segreti: possono solo sostituirla,
-- e solo per i clienti che gestiscono.
create function public.set_site_secret(cid uuid, encrypted text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_client(cid) then
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
revoke all on function public.set_site_secret(uuid, text) from public, anon;
grant execute on function public.set_site_secret(uuid, text) to authenticated;

-- Dice se la password è stata inserita, senza rivelarla.
create function public.has_site_secret(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_manage_client(cid) and exists (select 1 from client_secrets where client_id = cid);
$$;
revoke all on function public.has_site_secret(uuid) from public, anon;
grant execute on function public.has_site_secret(uuid) to authenticated;

-- Un utente non può cambiare a chi appartiene una chat o un contatto spostandoli tra clienti:
-- le regole di scrittura controllano sia la riga di partenza sia quella di arrivo (già così),
-- e qui si impedisce di modificare il cliente di una commessa o di un'azione già create.
create function public.keep_client_id() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.client_id is distinct from old.client_id then
    raise exception 'Il cliente di questa riga non si può cambiare';
  end if;
  return new;
end;
$$;
create trigger commesse_keep_client before update on public.commesse
  for each row execute function public.keep_client_id();
create trigger azioni_keep_client before update on public.azioni
  for each row execute function public.keep_client_id();
