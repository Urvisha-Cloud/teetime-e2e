/**
 * Visible cursor for watching headed runs. Playwright's Chrome window never shows the mouse pointer, so clicks
 * happen invisibly. This draws an arrow that follows the test's mouse (every locator.click() moves the mouse to
 * the element first), glides smoothly on plain moves, and on a click jumps onto the button and pulses in that same
 * instant, so the arrow is in sync with the action (it never delays or waits for anything). Fades after idle seconds.
 *
 * Only for the test browser (added with context.addInitScript in fixtures.ts); the app itself is not changed.
 * It never takes clicks: pointer-events are off, so Playwright's hit-testing ignores it.
 * Turn it off with TEETIME_SHOW_CURSOR=false.
 */
/** How long the arrow glides to a new position; guidedClick() waits this long before clicking. */
export const CURSOR_GLIDE_MS = 350;

/** Runs inside the page (context.addInitScript), so it only uses its arguments, nothing from this module. */
export function installCursor({ glideMs = 350, idleMs = 3000 }: { glideMs?: number; idleMs?: number } = {}) {
  const ID = "e2e-cursor";
  const IDLE_MS = idleMs; // stays visible through a reading pause, fades when nothing happens
  const GLIDE_MS = glideMs;

  const setup = () => {
    if (document.getElementById(ID)) return; // one cursor per page, never duplicated

    const style = document.createElement("style");
    style.textContent = `
      #${ID} {
        position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647;
        pointer-events: none; opacity: 0; will-change: transform;
        transition: transform ${GLIDE_MS}ms cubic-bezier(.22,.61,.36,1), opacity 300ms ease;
      }
      #${ID}.e2e-visible { opacity: 1; }
      #${ID} svg { width: 26px; height: 26px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      #${ID} .e2e-ring {
        position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 9999px;
        border: 3px solid #16a34a; opacity: 0; transform: scale(.4);
      }
      #${ID} .e2e-ring.e2e-pulse { animation: e2e-pulse 600ms ease-out; }
      @keyframes e2e-pulse {
        0% { opacity: .9; transform: scale(.4); }
        100% { opacity: 0; transform: scale(1.6); }
      }
    `;
    document.documentElement.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = ID;
    cursor.innerHTML =
      '<div class="e2e-ring"></div>' +
      '<svg viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.4 13.7 L17.5 13.7 Z" ' +
      'fill="#ffffff" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
    const ring = cursor.querySelector<HTMLElement>(".e2e-ring")!;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      cursor.classList.add("e2e-visible");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cursor.classList.remove("e2e-visible"), IDLE_MS);
    };

    // capture phase: modals that stop propagation still move the cursor
    window.addEventListener(
      "mousemove",
      (e) => {
        cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        show();
      },
      true,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        // Click: jump onto the button now (no glide) and pulse in the same instant as the action.
        // Purely visual and synchronous; nothing waits for it. Repeated clicks restart the same ring.
        cursor.style.transition = "opacity 300ms ease";
        cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        void cursor.offsetWidth;
        cursor.style.transition = "";
        show();
        ring.classList.remove("e2e-pulse");
        void ring.offsetWidth;
        ring.classList.add("e2e-pulse");
      },
      true,
    );
  };

  if (document.documentElement) setup();
  else document.addEventListener("DOMContentLoaded", setup, { once: true });
}
