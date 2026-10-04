# Production launch — remaining steps

Everything else is ready: the production D1 `sundus-yar-production` exists (id in `wrangler.jsonc`) with
migrations 0001–0009 applied, and the site builds in both designs (`npm run build:cinematic` / `build:classic`).
What is left needs the owner's Google account (Firebase now requires 2-Step Verification).

1. **Google 2-Step Verification** on the owner's account (myaccount.google.com → Security).
2. **Firebase project** (console.firebase.google.com): create the project (Analytics off), add a Web app,
   Authentication → Sign-in method → enable **Email/Password**, Settings → **Email enumeration protection on**,
   Authorized domains → add `sundus-yar-website.sundusyar.workers.dev` (and the custom domain later).
3. **Config** (public identifiers, not secrets):
   - `app/.env.production.local`:
     `VITE_FIREBASE_API_KEY=…`, `VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com`,
     `VITE_FIREBASE_PROJECT_ID=<project>`, `VITE_FIREBASE_APP_ID=…`
   - `wrangler.jsonc` → `vars.FIREBASE_PROJECT_ID` = the same project id.
   - `public/_headers` → in the CSP `frame-src`, replace `sundus-yar-website.firebaseapp.com` with the new auth domain.
4. **Build and deploy** (from `app/`):
   ```powershell
   npm run verify
   npm run build:cinematic      # or build:classic for the previous design
   npx wrangler deploy
   ```
5. **Become admin**: sign up on the live site with the owner's email, verify it, save the profile, then
   copy the uid from Firebase → Authentication → Users and run
   `node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid> --email <email> --remote`
   (it shows the exact SQL and asks for confirmation before writing).
6. **Smoke test**: sign in, send a test booking request, open `/admin`, approve it, use the WhatsApp buttons.

To return to the previous design at any time: `npm run build:classic` then `npx wrangler deploy`
(the original state is also tagged `design-classic-v1`).
