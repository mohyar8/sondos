// W1-13 (M6, SB-19): loaded with --import by the entry tests in
// tests/verify-gates.test.mjs. It shows scripts/verify.mjs to Node as an
// older Node would run it: without import.meta.main (Node before 24.2) and,
// when VERIFY_FIXTURE_NODE_VERSION is set, with that process.versions.node.
// Only that one file's source is rewritten; everything else loads unchanged.
import { registerHooks } from 'node:module'

const VERIFY_URL_SUFFIX = '/scripts/verify.mjs'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)

    if (!url.endsWith(VERIFY_URL_SUFFIX)) {
      return result
    }

    const version = process.env.VERIFY_FIXTURE_NODE_VERSION
    let source =
      typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8')

    source = source.replaceAll('import.meta.main', 'undefined')

    if (version !== undefined) {
      source = source.replaceAll('process.versions.node', JSON.stringify(version))
    }

    return { ...result, source }
  },
})
