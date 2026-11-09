/** Trigger-anchored usage details. */

import { useEffect, useId, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Open state, refs, and the unique CSS anchor for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  anchorStyle: CSSProperties & Record<'--dsh-usage-anchor', string>
}

/**
 * Own a trigger-anchored dialog's open state and outside dismissal.
 * @returns refs and a shared anchor style for the trigger wrapper and portaled panel.
 */
export function useStatDialog(): StatDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const id = useId()
  const anchorStyle: StatDialogSeat['anchorStyle'] = {
    '--dsh-usage-anchor': `--dsh-usage-${id.replaceAll(':', '')}`,
  }

  // Outside pointerdown closes through the shared primitive; the portaled
  // panel counts as inside. An outside click also closes, because keyboard
  // activation of a sibling trigger fires click without pointerdown; the
  // capture phase lets that click close this dialog before the sibling opens.
  // Escape closes.
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      if (e.target instanceof Node
        && rootRef.current?.contains(e.target) !== true
        && panelRef.current?.contains(e.target) !== true) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open, setOpen])

  return { open, setOpen, rootRef, panelRef, anchorStyle }
}
