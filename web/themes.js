// AutoDisc theme engine (presentation only). Themes are CSS skins; they never touch data, APIs or behaviour.
// To add a theme: add an entry here and a matching `:root[data-theme="<attr>"]` block in themes.css.
(function () {
  const STORAGE_KEY = "autodisc-theme";
  const DEFAULT_THEME = "modern-dark";
  // `attr` is the data-theme value. Modern themes keep the original "light"/"dark" values used by style.css.
  const THEMES = [
    { id: "modern-light", label: "Modern Light", attr: "light", scheme: "light", skin: "modern" },
    { id: "modern-dark", label: "Modern Dark", attr: "dark", scheme: "dark", skin: "modern" },
    { id: "win95", label: "Windows 95 Classic", attr: "win95", scheme: "light", skin: "retro" },
    { id: "dos", label: "DOS Terminal", attr: "dos", scheme: "dark", skin: "retro" }
  ];
  // Values saved by v1.37.0 and earlier.
  const LEGACY = { light: "modern-light", dark: "modern-dark" };

  function find(id) {
    return THEMES.find((theme) => theme.id === (LEGACY[id] || id));
  }

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function apply(id) {
    const theme = find(id) || find(DEFAULT_THEME);
    const root = document.documentElement;
    root.dataset.theme = theme.attr;
    root.dataset.skin = theme.skin;
    root.dataset.themeId = theme.id;
    root.style.colorScheme = theme.scheme;
    try { localStorage.setItem(STORAGE_KEY, theme.id); } catch { /* storage unavailable */ }
    document.dispatchEvent(new CustomEvent("autodisc-theme-change", { detail: { theme: theme.id } }));
    return theme.id;
  }

  apply(stored() || DEFAULT_THEME);

  window.AutoDiscThemes = {
    themes: THEMES.map((theme) => ({ id: theme.id, label: theme.label })),
    current: () => document.documentElement.dataset.themeId || DEFAULT_THEME,
    apply
  };
})();
