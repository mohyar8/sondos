/**
 * Cinematic design boot, imported once by src/main.tsx through
 * `@site-design/boot` before the first render. It marks the document so every
 * cinematic stylesheet scopes itself to `:root[data-design="cinematic"]`
 * (12-motion-spec.md §7.2, §8.3), and imports the motion layer's stylesheets
 * — §2 tokens, then the hero entrance and the scroll motion of §3 — in
 * cascade order. Later units add their own stylesheets through their own
 * components. Vite emits these files only in the cinematic build, because
 * only this twin imports them (§7.3).
 * The attribute name is spelled out so the build-output check (§7.3 item 4)
 * finds `data-design` in the cinematic bundle and never in the classic one.
 */
import './tokens.css'
import './hero.css'
import './scroll.css'

document.documentElement.setAttribute('data-design', 'cinematic')
