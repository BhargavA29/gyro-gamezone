const STORAGE_KEY = "gyro-color-scheme";

export type ColorSchemePreference = "dark" | "light" | "light dark";

function getMeta(): HTMLMetaElement | null {
  return document.querySelector('meta[name="color-scheme"]');
}

export function getRenderedScheme(): "dark" | "light" {
  const meta = getMeta();
  const content = meta?.content ?? "dark";
  if (content === "light") return "light";
  if (content === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyColorScheme(scheme: ColorSchemePreference): void {
  const meta = getMeta();
  if (meta) {
    meta.content = scheme;
  }
  try {
    if (scheme === "light dark") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, scheme);
    }
  } catch {
    // Storage blocked in private browsing; meta override still works for this session.
  }
}

export function toggleColorScheme(): "dark" | "light" {
  const current = getRenderedScheme();
  const next = current === "dark" ? "light" : "dark";
  applyColorScheme(next);
  return next;
}

export function bindThemeToggle(button: HTMLButtonElement): () => void {
  const onClick = () => {
    toggleColorScheme();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      const meta = getMeta();
      if (meta) {
        meta.content =
          e.newValue === "light" || e.newValue === "dark" ? e.newValue : "dark";
      }
    }
  };
  button.addEventListener("click", onClick);
  window.addEventListener("storage", onStorage);
  return () => {
    button.removeEventListener("click", onClick);
    window.removeEventListener("storage", onStorage);
  };
}

export function themeToggleHtml(): string {
  return `
    <button type="button" class="btn btn-ghost theme-toggle" data-theme-toggle>
      <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"></path>
      </svg>
      <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"></path>
      </svg>
      <span class="visually-hidden label-to-light">Switch to light theme</span>
      <span class="visually-hidden label-to-dark">Switch to dark theme</span>
    </button>
  `;
}
