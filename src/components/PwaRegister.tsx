"use client";

import { useEffect } from "react";

/** Registers the offline service worker in production builds only; dev chunks are unhashed and must not be cached. */
export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
