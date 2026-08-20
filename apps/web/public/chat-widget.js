(() => {
  "use strict";
  const script = document.currentScript;
  if (!script) return;
  const tenant = script.dataset.tenant;
  if (!tenant || !/^[a-z0-9-]+$/i.test(tenant)) return;
  const locale = script.dataset.locale === "hu" ? "hu" : "en";
  const position = script.dataset.position === "left" ? "left" : "right";
  const hostedOrigin = new URL(script.src).origin;
  const button = document.createElement("button");
  button.type = "button"; button.textContent = locale === "hu" ? "Segíthetek?" : "Can I help?";
  button.setAttribute("aria-expanded", "false");
  Object.assign(button.style, { position: "fixed", bottom: "20px", [position]: "20px", zIndex: "2147483646", border: "0", borderRadius: "999px", padding: "13px 18px", background: "#2563eb", color: "white", font: "600 14px system-ui", cursor: "pointer", boxShadow: "0 8px 30px rgba(0,0,0,.2)" });
  const frame = document.createElement("iframe");
  frame.title = locale === "hu" ? "Foglalási asszisztens" : "Booking assistant";
  frame.src = `${hostedOrigin}/${locale}/${encodeURIComponent(tenant)}/chat?parentOrigin=${encodeURIComponent(location.origin)}`;
  frame.setAttribute("allow", "clipboard-write");
  Object.assign(frame.style, { display: "none", position: "fixed", bottom: "76px", [position]: "20px", zIndex: "2147483645", width: "min(420px, calc(100vw - 24px))", height: "min(680px, calc(100vh - 100px))", border: "0", borderRadius: "18px", boxShadow: "0 18px 60px rgba(0,0,0,.28)", background: "white" });
  button.addEventListener("click", () => { const open = frame.style.display === "block"; frame.style.display = open ? "none" : "block"; button.setAttribute("aria-expanded", String(!open)); });
  window.addEventListener("message", (event) => {
    if (event.origin !== hostedOrigin || event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "bam-chat:close") { frame.style.display = "none"; button.setAttribute("aria-expanded", "false"); }
    if (event.data.type === "bam-chat:resize" && Number.isFinite(event.data.height)) frame.style.height = `${Math.max(320, Math.min(680, event.data.height))}px`;
  });
  document.body.append(frame, button);
})();
