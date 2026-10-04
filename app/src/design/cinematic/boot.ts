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
import './extras.css'
import { brandIntroLogo } from '../../data/brand-images'
import { playIntroOnce } from './intro'

document.documentElement.setAttribute('data-design', 'cinematic')

// The gold reading-progress line (extras.css §5). Outside React's tree, so
// the router never touches it; decorative, so hidden from assistive tech.
const progressLine = document.createElement('div')
progressLine.className = 'cine-progress'
progressLine.setAttribute('aria-hidden', 'true')
document.body.append(progressLine)

playIntroOnce(brandIntroLogo.webp448)
