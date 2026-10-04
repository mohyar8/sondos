export {}

declare global {
  interface Env {
    RESEND_API_KEY?: string
    EMAIL_FROM?: string
    ADMIN_NOTIFICATION_EMAIL?: string
    EMAIL_REPLY_TO?: string
    APP_BASE_URL?: string
  }
}