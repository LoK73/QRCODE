-- Da eseguire UNA volta nell'SQL Editor di Supabase, dopo le migrazioni.
-- Sostituisci i valori tra < > prima di eseguire.

-- 1. Utente del database per la dashboard.
--    Non ha permessi propri: può solo "diventare" un utente collegato (ruolo authenticated),
--    quindi ogni sua query è soggetta alle regole RLS dello schema.
create role dashboard_app login password '<PASSWORD-LUNGA-E-CASUALE>' noinherit;
grant authenticated to dashboard_app;
grant usage on schema public to dashboard_app;

-- 2. Primo amministratore dell'agenzia.
--    Prima crea il tuo utente in Supabase → Authentication → Users → Add user,
--    poi assegnagli il ruolo di admin (gli altri utenti si gestiscono dalla dashboard).
insert into public.profiles (id, full_name, email)
select id, '<Nome Cognome>', email from auth.users where email = '<la-tua-email>'
on conflict (id) do update set full_name = excluded.full_name;

insert into public.memberships (user_id, client_id, role)
select id, null, 'admin_agenzia' from auth.users where email = '<la-tua-email>';
