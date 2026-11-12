"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect } from "react";

/** Tiene viva la sessione di Supabase: il client del browser rinnova da solo il token e aggiorna i cookie. */
export function SessionKeeper({ url, anonKey }: { url: string; anonKey: string }) {
  useEffect(() => {
    const supabase = createBrowserClient(url, anonKey);
    const { data } = supabase.auth.onAuthStateChange(() => {});
    return () => data.subscription.unsubscribe();
  }, [url, anonKey]);
  return null;
}
