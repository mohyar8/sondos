import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseOptions,
} from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from 'firebase/auth'

const CONFIGURATION_ERROR_MESSAGE =
  'إعدادات تسجيل الدخول غير متاحة حاليًا.'
const INITIALIZATION_ERROR_MESSAGE = 'تعذر تهيئة خدمة تسجيل الدخول.'

const requiredEnvironmentValues = [
  ['VITE_FIREBASE_API_KEY', import.meta.env.VITE_FIREBASE_API_KEY],
  ['VITE_FIREBASE_AUTH_DOMAIN', import.meta.env.VITE_FIREBASE_AUTH_DOMAIN],
  ['VITE_FIREBASE_PROJECT_ID', import.meta.env.VITE_FIREBASE_PROJECT_ID],
  ['VITE_FIREBASE_APP_ID', import.meta.env.VITE_FIREBASE_APP_ID],
] as const

type RequiredEnvironmentName =
  (typeof requiredEnvironmentValues)[number][0]

type FirebaseConfigurationResult =
  | { ok: true; config: FirebaseOptions }
  | { ok: false; missingVariable: RequiredEnvironmentName }

export type FirebaseAuthInitialization =
  | {
      ok: true
      auth: Auth
      ready: Promise<void>
    }
  | {
      ok: false
      error: {
        code: 'CONFIGURATION_UNAVAILABLE' | 'INITIALIZATION_FAILED'
        message: string
      }
    }

type SuccessfulFirebaseAuthInitialization = Extract<
  FirebaseAuthInitialization,
  { ok: true }
>

let successfulInitialization: SuccessfulFirebaseAuthInitialization | null =
  null

function readEnvironmentValue(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalizedValue = value.trim()

  return normalizedValue.length > 0 ? normalizedValue : null
}

function readFirebaseConfig(): FirebaseConfigurationResult {
  const requiredValues = new Map<RequiredEnvironmentName, string>()

  for (const [name, value] of requiredEnvironmentValues) {
    const normalizedValue = readEnvironmentValue(value)

    if (!normalizedValue) {
      return {
        ok: false,
        missingVariable: name,
      }
    }

    requiredValues.set(name, normalizedValue)
  }

  const storageBucket = readEnvironmentValue(
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  )
  const messagingSenderId = readEnvironmentValue(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  )

  const config: FirebaseOptions = {
    apiKey: requiredValues.get('VITE_FIREBASE_API_KEY'),
    authDomain: requiredValues.get('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: requiredValues.get('VITE_FIREBASE_PROJECT_ID'),
    appId: requiredValues.get('VITE_FIREBASE_APP_ID'),
  }

  if (storageBucket) {
    config.storageBucket = storageBucket
  }

  if (messagingSenderId) {
    config.messagingSenderId = messagingSenderId
  }

  return {
    ok: true,
    config,
  }
}

function unavailableInitialization(
  code: 'CONFIGURATION_UNAVAILABLE' | 'INITIALIZATION_FAILED',
  missingVariable?: RequiredEnvironmentName,
): FirebaseAuthInitialization {
  const developmentConfigurationMessage = missingVariable
    ? `${CONFIGURATION_ERROR_MESSAGE} المتغير ${missingVariable} مفقود أو فارغ.`
    : CONFIGURATION_ERROR_MESSAGE

  return {
    ok: false,
    error: {
      code,
      message:
        code === 'CONFIGURATION_UNAVAILABLE'
          ? import.meta.env.DEV
            ? developmentConfigurationMessage
            : CONFIGURATION_ERROR_MESSAGE
          : INITIALIZATION_ERROR_MESSAGE,
    },
  }
}

export function getFirebaseAuthInitialization(): FirebaseAuthInitialization {
  if (successfulInitialization) {
    return successfulInitialization
  }

  const configurationResult = readFirebaseConfig()

  if (!configurationResult.ok) {
    return unavailableInitialization(
      'CONFIGURATION_UNAVAILABLE',
      configurationResult.missingVariable,
    )
  }

  try {
    const app =
      getApps().length > 0
        ? getApp()
        : initializeApp(configurationResult.config)
    const auth = getAuth(app)
    const ready = setPersistence(auth, browserLocalPersistence)

    const initialization: SuccessfulFirebaseAuthInitialization = {
      ok: true,
      auth,
      ready,
    }

    successfulInitialization = initialization

    void ready.catch(() => {
      if (successfulInitialization === initialization) {
        successfulInitialization = null
      }
    })

    return initialization
  } catch {
    return unavailableInitialization('INITIALIZATION_FAILED')
  }
}