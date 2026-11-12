-- Preferenza per le email "c'è una modifica da approvare".
alter table public.profiles add column if not exists email_notifications boolean not null default true;
