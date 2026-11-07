/** Monochrome hero artwork and a blank running-artwork slot for Hemi. */
import css from './HemiBrandMark.module.css'

/** Presentation supplied by a brand-mark host. */
interface MarkProps {
  size: number
  className?: string | undefined
}

/**
 * Render the wave-H as a monochrome mask; its empty areas remain transparent.
 * @param props - Host size and optional layout class.
 * @returns a decorative Hemi mark using the theme's neutral text color.
 */
export function HemiBrandMark({ size, className }: MarkProps) {
  return <span aria-hidden="true" data-hemi-brand-mark className={`${css.mark} ${className ?? ''}`}
    style={{ width: size, height: size }} />
}

/**
 * Suppress the native running artwork while preserving the status text and clock.
 * @returns no artwork or layout placeholder.
 */
export function HemiRunningMark() {
  return null
}
