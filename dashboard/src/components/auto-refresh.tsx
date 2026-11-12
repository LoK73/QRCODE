"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Ricarica i dati della pagina ogni tot secondi, così l'elenco si aggiorna da solo. */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
