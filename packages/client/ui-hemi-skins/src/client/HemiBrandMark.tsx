/** Theme-inheriting monochrome Hemi artwork for the hero and running status. */
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
 * Render the running mark with reduced-motion-aware opacity animation.
 * @returns a decorative status mark without changing the status text or clock.
 */
export function HemiRunningMark() {
  return <span className={css.running}><HemiBrandMark size={18} /></span>
}
