// The server generates chat QR images only for an entitled subscription.
// Hide chat links on denied/failed requests; never guess the plan in this site.
const chatQr = document.querySelector("[data-chat-qr]");
if (chatQr) {
  const sync = () => {
    const available = chatQr.complete && chatQr.naturalWidth > 0;
    for (const link of document.querySelectorAll("[data-chat-link]")) {
      link.hidden = !available;
    }
  };
  chatQr.addEventListener("load", sync);
  chatQr.addEventListener("error", sync);
  sync();
}
