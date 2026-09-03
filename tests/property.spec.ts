import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { slugifyName, isReservedFileName, INDEX_FILE } from '../src/storage/paths.ts'
import { expandQueryTerms, textSimilarity } from '../src/text.ts'

// Names mixing filesystem-forbidden chars, whitespace and CJK, long enough to
// exercise the 40-char truncation path in slugifyName.
const messyName = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc
    .array(
      fc.constantFrom('a', 'B', '中', '文', '/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '\t', '\n', '-', '.'),
      { maxLength: 80 },
    )
    .map(cs => cs.join('')),
)

// Non-empty text over a whitespace-free alphabet, so expandQueryTerms always
// yields at least one term (needed for the Dice self-similarity = 1 property).
const word = fc
  .array(fc.constantFrom(...'abcXYZ中文查询部署0129-._/api'), { minLength: 1, maxLength: 24 })
  .map(cs => cs.join(''))

// One contiguous run of Han chars in slugifyName's CJK range (U+4E00..U+9FFF).
const cjkRun = fc
  .array(
    fc.integer({ min: 0x4e00, max: 0x9fff }).map(c => String.fromCodePoint(c)),
    { minLength: 2, maxLength: 8 },
  )
  .map(cs => cs.join(''))

describe('slugifyName', () => {
  // INVARIANT: slugifyName is idempotent — slug(slug(x)) === slug(x). The arbitrary
  // targets the 40-char cut: 39 filler chars, one separator (collapsed to '-') and a
  // non-dash tail, so the cut lands exactly on the collapsed dash.
  const boundaryDash = fc
    .tuple(
      fc.constantFrom('a', 'b', 'x', '9', '中'),
      fc.constantFrom(' ', '  ', '/', '\\', ':', '\t'),
      fc.array(fc.constantFrom(...'abcxyz019中文'), { minLength: 1, maxLength: 6 }).map(cs => cs.join('')),
    )
    .map(([fill, sep, tail]) => fill.repeat(39) + sep + tail)
  it('is idempotent, including at the truncation boundary', () => {
    fc.assert(
      fc.property(boundaryDash, name => {
        expect(slugifyName(slugifyName(name))).toBe(slugifyName(name))
      }),
    )
  })

  // INVARIANT: the slug never contains a filesystem-forbidden char or whitespace,
  // is at most 40 chars, and is never empty (falls back to "memory").
  it('produces only safe chars, bounded length, never empty', () => {
    fc.assert(
      fc.property(messyName, name => {
        const slug = slugifyName(name)
        expect(slug.length).toBeGreaterThan(0)
        expect(slug.length).toBeLessThanOrEqual(40)
        expect(slug).not.toMatch(/[/\\:*?"<>|\s]/)
      }),
    )
  })

  // Not a contract: slugifyName is case-preserving by design (directory/file names keep
  // the user's casing); case-insensitive comparison lives in the rename path
  // (file-table) and in isReservedFileName, which the next block covers.
})

describe('isReservedFileName', () => {
  // INVARIANT: every case variant of the index file name is always reserved.
  const indexCaseVariant = fc
    .tuple(...[...INDEX_FILE].map(ch => fc.constantFrom(ch.toLowerCase(), ch.toUpperCase())))
    .map(chars => chars.join(''))
  it('flags every case variant of the index file name', () => {
    fc.assert(
      fc.property(indexCaseVariant, name => {
        expect(isReservedFileName(name)).toBe(true)
      }),
    )
  })

  // INVARIANT: a name that differs from the index file by more than case (i.e. is
  // not a case variant of it) is never reported reserved.
  it('never flags a name that is not a case variant of the index file', () => {
    fc.assert(
      fc.property(messyName, name => {
        fc.pre(name.toLowerCase() !== INDEX_FILE.toLowerCase())
        expect(isReservedFileName(name)).toBe(false)
      }),
    )
  })
})

describe('expandQueryTerms', () => {
  // INVARIANT: every emitted term is non-empty.
  it('emits only non-empty terms', () => {
    fc.assert(
      fc.property(messyName, kw => {
        for (const term of expandQueryTerms(kw)) expect(term.length).toBeGreaterThan(0)
      }),
    )
  })

  // INVARIANT: for a contiguous CJK query, every adjacent bigram of the input appears.
  it('covers every adjacent bigram of a contiguous CJK query', () => {
    fc.assert(
      fc.property(cjkRun, run => {
        const terms = new Set(expandQueryTerms(run))
        const chars = [...run]
        for (let i = 0; i < chars.length - 1; i++) {
          expect(terms.has(chars[i] + chars[i + 1])).toBe(true)
        }
      }),
    )
  })
})

describe('textSimilarity (Dice)', () => {
  // INVARIANT: the Dice coefficient is symmetric in its two arguments.
  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(textSimilarity(a, b)).toBe(textSimilarity(b, a))
      }),
    )
  })

  // INVARIANT: an identical (non-empty) string scores exactly 1.
  it('scores 1 for two identical non-empty strings', () => {
    fc.assert(
      fc.property(word, a => {
        expect(textSimilarity(a, a)).toBe(1)
      }),
    )
  })

  // INVARIANT: self-similarity is maximal and the score is bounded to [0, 1], so
  // replacing the identical copy with any (unrelated) string cannot raise the score.
  it('is bounded and non-increasing away from an identical string', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sim = textSimilarity(a, b)
        expect(sim).toBeGreaterThanOrEqual(0)
        expect(sim).toBeLessThanOrEqual(1)
        expect(textSimilarity(a, a)).toBeGreaterThanOrEqual(sim)
      }),
    )
  })
})
