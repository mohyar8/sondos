import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// The build's design layer (classic or cinematic, chosen in vite.config.ts).
import '@site-design/boot'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext.tsx'
import ReauthenticationHost from './auth/ReauthenticationHost.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
      {/* The one «confirm your password» prompt, for every route. */}
      <ReauthenticationHost />
    </AuthProvider>
  </StrictMode>,
)
