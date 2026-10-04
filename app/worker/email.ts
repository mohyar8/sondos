import type {
  EmailDeliveryFailureReason,
  EmailDeliveryResult,
  EmailMessageInput,
} from '../shared/notifications.js'

const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails'
const REQUEST_TIMEOUT_MILLISECONDS = 10_000
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 256
const MAXIMUM_EMAIL_ADDRESS_LENGTH = 254
const MAXIMUM_SENDER_LENGTH = 320
const MAXIMUM_API_KEY_LENGTH = 512
const MAXIMUM_SUBJECT_LENGTH = 998
const MAXIMUM_MESSAGE_LENGTH = 1_000_000

interface ResendSuccessResponse {
  id: string
}

function failed(
  reason: EmailDeliveryFailureReason,
): EmailDeliveryResult {
  return {
    status: 'failed',
    reason,
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function isValidEmailAddress(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_EMAIL_ADDRESS_LENGTH ||
    containsControlCharacter(value)
  ) {
    return false
  }

  const atIndex = value.lastIndexOf('@')

  if (atIndex <= 0 || atIndex === value.length - 1) {
    return false
  }

  const localPart = value.slice(0, atIndex)
  const domain = value.slice(atIndex + 1)

  if (
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart) ||
    domain.length > 253 ||
    !domain.includes('.')
  ) {
    return false
  }

  const domainLabels = domain.split('.')

  return domainLabels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-') &&
      /^[A-Z0-9-]+$/i.test(label),
  )
}

function getSenderEmailAddress(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_SENDER_LENGTH ||
    containsControlCharacter(value)
  ) {
    return null
  }

  const openBracketIndex = value.lastIndexOf('<')
  const closeBracketIndex = value.lastIndexOf('>')

  if (openBracketIndex === -1 && closeBracketIndex === -1) {
    return isValidEmailAddress(value) ? value : null
  }

  if (
    openBracketIndex <= 0 ||
    closeBracketIndex !== value.length - 1 ||
    value.indexOf('<') !== openBracketIndex ||
    value.indexOf('>') !== closeBracketIndex
  ) {
    return null
  }

  const displayName = value.slice(0, openBracketIndex).trim()
  const address = value.slice(openBracketIndex + 1, closeBracketIndex).trim()

  return displayName.length > 0 && isValidEmailAddress(address)
    ? address
    : null
}

function isValidTextField(
  value: string,
  maximumLength: number,
): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsControlCharacter(value)
  )
}

function isValidMessageContent(value: string): boolean {
  return value.length > 0 && value.length <= MAXIMUM_MESSAGE_LENGTH
}

function isValidIdempotencyKey(value: string): boolean {
  return isValidTextField(value, MAXIMUM_IDEMPOTENCY_KEY_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResendSuccessResponse(
  value: unknown,
): ResendSuccessResponse | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null
  }

  const id = value.id.trim()

  return id.length > 0 && id.length <= 256
    ? { id }
    : null
}

export async function sendEmail(
  env: Env,
  input: EmailMessageInput,
): Promise<EmailDeliveryResult> {
  const apiKey = env.RESEND_API_KEY?.trim()
  const from = env.EMAIL_FROM?.trim()

  if (!apiKey || !from) {
    return {
      status: 'skipped',
      reason: 'NOT_CONFIGURED',
    }
  }

  if (!getSenderEmailAddress(from)) {
    return failed('INVALID_CONFIGURATION')
  }

  if (
    apiKey.length > MAXIMUM_API_KEY_LENGTH ||
    containsControlCharacter(apiKey)
  ) {
    return failed('INVALID_CONFIGURATION')
  }

  const to = input.to.trim()
  const subject = input.subject.trim()
  const idempotencyKey = input.idempotencyKey.trim()
  const configuredReplyTo = env.EMAIL_REPLY_TO?.trim()
  const inputReplyTo = input.replyTo?.trim()
  const replyTo = inputReplyTo || configuredReplyTo

  if (
    !isValidEmailAddress(to) ||
    !isValidTextField(subject, MAXIMUM_SUBJECT_LENGTH) ||
    !isValidMessageContent(input.html) ||
    !isValidMessageContent(input.text) ||
    !isValidIdempotencyKey(idempotencyKey)
  ) {
    return failed('INVALID_MESSAGE')
  }

  if (replyTo && !isValidEmailAddress(replyTo)) {
    return failed(
      inputReplyTo
        ? 'INVALID_MESSAGE'
        : 'INVALID_CONFIGURATION',
    )
  }

  const requestBody: Record<string, unknown> = {
    from,
    to: [to],
    subject,
    html: input.html,
    text: input.text,
  }

  if (replyTo) {
    requestBody.reply_to = replyTo
  }

  const abortController = new AbortController()
  const timeoutId = setTimeout(
    () => abortController.abort(),
    REQUEST_TIMEOUT_MILLISECONDS,
  )

  try {
    const response = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    })

    if (!response.ok) {
      return failed(
        response.status === 429
          ? 'RATE_LIMITED'
          : 'PROVIDER_REJECTED',
      )
    }

    let responseBody: unknown

    try {
      responseBody = await response.json()
    } catch {
      return failed('INVALID_PROVIDER_RESPONSE')
    }

    const resendResponse = parseResendSuccessResponse(responseBody)

    if (!resendResponse) {
      return failed('INVALID_PROVIDER_RESPONSE')
    }

    return {
      status: 'sent',
      providerMessageId: resendResponse.id,
    }
  } catch {
    return failed(
      abortController.signal.aborted
        ? 'PROVIDER_TIMEOUT'
        : 'NETWORK_FAILURE',
    )
  } finally {
    clearTimeout(timeoutId)
  }
}