-- Prestazioni, su indicazione dei controlli di Supabase.

-- Indici sulle chiavi esterne usate nei filtri e nelle cancellazioni a cascata.
create index if not exists azioni_client on public.azioni (client_id);
create index if not exists azioni_richiesta_da on public.azioni (richiesta_da);
create index if not exists consumi_ai_commessa on public.consumi_ai (commessa_id);
create index if not exists memberships_client on public.memberships (client_id);
create index if not exists messaggi_client on public.messaggi (client_id);

-- auth.uid() dentro una sottoselezione viene calcolato una volta per query, non per riga.
drop policy profiles_select on public.profiles;
drop policy profiles_update on public.profiles;
drop policy profiles_insert on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_agency());
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

-- Una sola regola per la lettura: le regole di scrittura coprono solo inserimento,
-- modifica e cancellazione (prima "for all" si sommava a quella di lettura).
drop policy memberships_select on public.memberships;
drop policy memberships_write on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.is_agency());
create policy memberships_insert on public.memberships for insert to authenticated with check (private.is_agency_admin());
create policy memberships_update on public.memberships for update to authenticated
  using (private.is_agency_admin()) with check (private.is_agency_admin());
create policy memberships_delete on public.memberships for delete to authenticated using (private.is_agency_admin());

drop policy sites_write on public.client_sites;
create policy sites_insert on public.client_sites for insert to authenticated with check (private.can_manage_client(client_id));
create policy sites_update on public.client_sites for update to authenticated
  using (private.can_manage_client(client_id)) with check (private.can_manage_client(client_id));
create policy sites_delete on public.client_sites for delete to authenticated using (private.can_manage_client(client_id));

drop policy channels_write on public.client_channels;
create policy channels_insert on public.client_channels for insert to authenticated with check (private.can_manage_client(client_id));
create policy channels_update on public.client_channels for update to authenticated
  using (private.can_manage_client(client_id)) with check (private.can_manage_client(client_id));
create policy channels_delete on public.client_channels for delete to authenticated using (private.can_manage_client(client_id));

drop policy contacts_write on public.contacts;
create policy contacts_insert on public.contacts for insert to authenticated with check (private.can_manage_client(client_id));
create policy contacts_update on public.contacts for update to authenticated
  using (private.can_manage_client(client_id)) with check (private.can_manage_client(client_id));
create policy contacts_delete on public.contacts for delete to authenticated using (private.can_manage_client(client_id));

drop policy azioni_insert on public.azioni;
create policy azioni_insert on public.azioni for insert to authenticated with check (
  richiesta_da = (select auth.uid())
  and stato = 'in_coda'
  and esito is null
  and (
    (tipo = 'prova_sito' and private.can_manage_client(client_id))
    or (
      tipo <> 'prova_sito'
      and private.can_decide_client(client_id)
      and exists (select 1 from public.commesse k where k.id = commessa_id and k.client_id = azioni.client_id)
    )
  )
);
