"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { Download, WifiOff } from "lucide-react";
import { Button } from "./ui/button";
import { Brand } from "./brand";

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const InstallContext = createContext<{
  event: InstallEvent | null;
  installed: boolean;
  clear: () => void;
}>({ event: null, installed: false, clear: () => {} });

/** Mounted above the workspace so disconnected screens cannot offer new writes. */
export function StaffPwa({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname();
  const staff =
    /^\/dashboard(?:\/|$)/.test(pathname) || /^\/(?:[^/]+\/)?sign-in\/?$/.test(pathname);
  const installationSurface =
    staff || pathname === "/" || /^\/[^/]+\/install\/(staff|patient)$/.test(pathname);
  const t = useTranslations("pwa");
  const [offline, setOffline] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const notice = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!installationSurface) return;
    const media = window.matchMedia("(display-mode: standalone)");
    const sync = () => setOffline(!navigator.onLine);
    const appearance = () =>
      setInstalled(
        media.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
    const capture = (value: Event) => {
      value.preventDefault();
      setEvent(value as InstallEvent);
    };
    const complete = () => {
      setInstalled(true);
      setEvent(null);
    };
    sync();
    appearance();
    window.addEventListener("offline", sync);
    window.addEventListener("online", sync);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", complete);
    media.addEventListener("change", appearance);
    if (
      process.env.NODE_ENV === "production" &&
      "serviceWorker" in navigator &&
      window.isSecureContext
    ) {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {
          // Installation enhancement must never prevent online use of the workspace.
        });
    }
    return () => {
      window.removeEventListener("offline", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", complete);
      media.removeEventListener("change", appearance);
    };
  }, [installationSurface]);

  const blocked = staff && offline;
  useEffect(() => {
    if (blocked) notice.current?.focus();
  }, [blocked]);

  return (
    <InstallContext.Provider value={{ event, installed, clear: () => setEvent(null) }}>
      <div hidden={blocked} inert={blocked}>
        {children}
      </div>
      {blocked ? (
        <main className="grid min-h-screen place-items-center bg-surface px-4 py-8">
          <section
            ref={notice}
            tabIndex={-1}
            role="alert"
            aria-labelledby="offline-title"
            className="w-full max-w-lg rounded-xl border border-line p-6 sm:p-8"
          >
            <Brand />
            <WifiOff aria-hidden="true" className="mt-8 text-primary" size={28} />
            <h1 id="offline-title" className="mt-4 font-display text-2xl font-bold">
              {t("offlineTitle")}
            </h1>
            <p className="mt-4 leading-relaxed text-ink-muted">{t("offlineDescription")}</p>
            <Button className="mt-6" onClick={() => window.location.reload()}>
              {t("retry")}
            </Button>
          </section>
        </main>
      ) : null}
    </InstallContext.Provider>
  );
}

export function InstallApp(): React.ReactElement | null {
  const t = useTranslations("pwa");
  const { event, installed, clear } = useContext(InstallContext);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [platform, setPlatform] = useState("other");
  useEffect(() => {
    const ua = navigator.userAgent;
    setPlatform(
      /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
        ? "ios"
        : /Android/.test(ua)
          ? "android"
          : /Edg|Chrome/.test(ua)
            ? "desktop"
            : "other",
    );
  }, []);
  if (installed) return null;
  async function install() {
    if (!event) {
      setHelp((value) => !value);
      return;
    }
    setBusy(true);
    setFailed(false);
    clear();
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      setFailed(true);
      setHelp(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => void install()}
        aria-expanded={help}
        aria-controls="pwa-install-help"
      >
        <Download size={18} aria-hidden="true" />
        {t("install")}
      </Button>
      {help ? (
        <div
          id="pwa-install-help"
          className="max-w-sm rounded-lg border border-line bg-surface-raised p-4 text-sm leading-relaxed"
          role="status"
        >
          {failed ? <p className="mb-2">{t("installFailed")}</p> : null}
          <p>
            {t(
              platform === "ios"
                ? "iosHelp"
                : platform === "android"
                  ? "androidHelp"
                  : platform === "desktop"
                    ? "desktopHelp"
                    : "otherHelp",
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
