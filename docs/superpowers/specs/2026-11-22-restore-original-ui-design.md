# Restore original GatePass UI across the full site — design spec

Date: 2026-11-22
Status: approved

## Goal
Keep every current feature (events feed, calendar, discover, create/editor, members, approval, QR passes, gate code, share) but restyle the homepage and all its views to the original GatePass riso-poster aesthetic. Gate/pass/register pages already use it and stay unchanged.

## Aesthetic direction (from the original)
- Warm paper `#F6F1EF` with fibre-grain texture; deep blue ink `#1A43B4` for text/headings; fluoro pink `#FF2FA2` for rules, marks and display accents.
- Display type: Oswald condensed uppercase; reading type: Barlow Semi Condensed. Both fonts already bundled.
- Surfaces: pink-tint `#F8D5E4` rows/cards with 12px corners, dotted pink rules, scalloped footer strip, slight riso mottle textures.
- Primary plates: blue button with white text, or pink accent; no charcoal/white Luma look.

## Implementation
- Rewrite `assets/css/luma.css` (still scoped to `body.luma`) to reuse the CSS variables and texture assets from `gatepass.css`, mapping every `.l-*` component to the riso style: nav, cards, calendar, discover, editor, modal, members table, status pills, QR card, gate panel.
- Keep all DOM/classes/JS behaviour in `assets/js/events.js` unchanged — this is a CSS-only visual change.
- Update `index.html`: `theme-color` back to `#F6F1EF`; refresh the internal comment to describe the riso styling.
- Ensure accessibility/contrast: ink text on paper, white on blue/pink plates, readable status pills.

## Testing
- Render every route at desktop and mobile: feed, calendar, discover, create, event detail (owner + pending/approved member), members table, QR modal. No console errors; visual match to the original poster style.
- Run E2E suite to confirm no functional regression.

## Out of scope
Changing gate/pass/register pages (already original style); removing features; changing data model.
