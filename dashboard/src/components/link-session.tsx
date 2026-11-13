"use client";

import { useEffect, useState } from "react";
import { adoptSession } from "@/lib/actions";

/**
 * I link di invito e di recupero password di Supabase riportano qui con i dati di accesso
 * dopo il "#" dell'indirizzo, che il server non vede: questo componente li legge, li passa
 * al server (che apre la sessione) e toglie il "#" dalla barra degli indirizzi.
 */
export function LinkSession() {
  const [error, setError] = useState("");

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const problem = params.get("error_description") ?? params.get("error");
    if (!accessToken && !problem) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!accessToken || !refreshToken) {
      setError("Il link non è più valido: forse è scaduto o è già stato usato. Chiedine uno nuovo.");
      return;
    }
    const form = new FormData();
    form.set("access_token", accessToken);
    form.set("refresh_token", refreshToken);
    void adoptSession(form).catch(() => setError("Non sono riuscito ad aprire la sessione da questo link. Chiedine uno nuovo."));
  }, []);

  if (!error) return null;
  return (
    <p role="alert" className="notice errore" style={{ margin: 16 }}>
      {error} <a href="/recupero">Recupera la password</a>
    </p>
  );
}
