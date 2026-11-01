# Themes

AutoDisc 2.0 ships a presentation-only theme engine. Themes never change behaviour, workflows, APIs, state or settings.

| Id | Name | `data-theme` | `data-skin` |
| --- | --- | --- | --- |
| `modern-light` | Modern Light | `light` | `modern` |
| `modern-dark` | Modern Dark (default) | `dark` | `modern` |
| `win95` | Windows 95 Classic | `win95` | `retro` |
| `dos` | DOS Terminal | `dos` | `retro` |

## How it works

- [`web/themes.js`](../web/themes.js) defines the theme list and exposes `window.AutoDiscThemes` (`themes`, `current()`, `apply(id)`). It runs from `<head>` so the saved theme is applied before first paint.
- The choice is stored in `localStorage["autodisc-theme"]`. Legacy `light` and `dark` values migrate to Modern Light and Modern Dark.
- `apply()` sets `data-theme`, `data-skin` and `data-theme-id` on `<html>` and fires an `autodisc-theme-change` event.
- [`web/themes.css`](../web/themes.css) holds the variables and the shared retro skin. Modern Light and Dark are still defined in [`web/style.css`](../web/style.css).
- The picker (`#theme-select`) replaces the old Light/Dark button in the top bar.

## What a theme may change

Colours, borders, fonts, spacing, glyphs and chrome layout (for example the title-bar headings in Windows 95 or the `[ button ]` labels in DOS). A theme may hide decorative elements only; the allowed list is enforced by tests.

## Adding a theme

1. Add an entry to `THEMES` in `web/themes.js` (`id`, `label`, `attr`, `scheme`, `skin`).
2. Add a `:root[data-theme="<attr>"]` block in `web/themes.css` that defines the colour variables.
3. For a retro-style layout, use `data-skin="retro"` and add rules scoped to your `data-theme`.
4. Run `npm test`. `test/themes.test.js` checks the interface against `test/fixtures/v1.37.0-ui-hooks.json` and fails if an element id, form field, page or navigation target disappears, or if a theme touches APIs or settings.
