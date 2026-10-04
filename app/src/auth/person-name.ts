// The name rule (SEC-10) lives in shared/text.ts (plan R-07), one rule for
// the forms and the Worker; this path stays for the SPA modules that import
// it.
export {
  MAXIMUM_PERSON_NAME_LENGTH,
  normalizePersonName,
} from '../../shared/text'
