import { Fragment } from 'react'
import { isCinematicDesign } from '../design/runtime'

interface DisplayHeadingProps {
  as?: 'h1' | 'h2'
  id?: string
  className?: string
  text: string
  /** Draws the gold khatam ornament under the heading (cinematic only). */
  ornament?: boolean
}

/**
 * A display heading whose words rise one by one from behind a mask in the
 * cinematic design (12-motion-spec.md E5). The text is split on spaces only —
 * never inside a word — so Arabic letters keep their joins and ligatures, and
 * the spaces stay real text, so the accessible name, copy and search are
 * unchanged. In the classic design it renders the plain heading.
 */
export default function DisplayHeading({
  as: Tag = 'h2',
  id,
  className,
  text,
  ornament = false,
}: DisplayHeadingProps) {
  if (!isCinematicDesign()) {
    return (
      <Tag id={id} className={className}>
        {text}
      </Tag>
    )
  }

  const words = text.trim().split(/\s+/)

  return (
    <>
      <Tag
        id={id}
        className={className ? `${className} cine-words` : 'cine-words'}
      >
        {words.map((word, index) => (
          <Fragment key={index}>
            {index > 0 && ' '}
            <span className="cine-w">
              <span className="cine-w__i">{word}</span>
            </span>
          </Fragment>
        ))}
      </Tag>
      {ornament && <SectionOrnament />}
    </>
  )
}

/** Two gold lines and an eight-point khatam star that draw themselves. */
function SectionOrnament() {
  return (
    <svg
      className="cine-ornament"
      viewBox="0 0 160 24"
      aria-hidden="true"
      focusable="false"
    >
      <path className="cine-ornament__line" d="M68 12H4" pathLength={1} />
      <path className="cine-ornament__line" d="M92 12h64" pathLength={1} />
      <rect
        className="cine-ornament__star"
        x="72.5"
        y="4.5"
        width="15"
        height="15"
        pathLength={1}
      />
      <rect
        className="cine-ornament__star cine-ornament__star--turned"
        x="72.5"
        y="4.5"
        width="15"
        height="15"
        pathLength={1}
      />
      <circle className="cine-ornament__dot" cx="80" cy="12" r="2.2" />
    </svg>
  )
}
