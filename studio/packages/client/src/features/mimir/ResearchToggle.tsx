// @ts-nocheck 鈥?vendored ui-mimir island: React 18 JSX plus dsh-* SDK modules that exist only as ambient stubs here, so project-wide type checking cannot cover it. Transformed by esbuild with jsxImportSource=react and verified at runtime.
/**
 * The sidebar-footer research toggle: opens and closes the panel overlay. All
 * state lives in the store it shares with the panel entry; the button only
 * reads `open` (for aria-pressed) and writes through `actions.toggleOpen`.
 * @module dsh-client-ui-mimir/client/ResearchToggle
 */

import type { ResearchToggleProps } from './slots.ts'
import css from './ResearchToggle.module.css'

/**
 * One footer action button beside Settings.
 * @param props - the owner's column state, the shared panel store, and copy.
 * @returns the toggle button.
 */
export function ResearchToggle({ wide, useStore, actions, t }: ResearchToggleProps) {
  const open = useStore(state => state.open)
  return (
    <button
      type="button"
      className={css.toggle}
      aria-pressed={open}
      aria-label={t('toggle')}
      title={t('toggle')}
      onClick={() => { actions.toggleOpen() }}
    >
      {wide ? t('toggle') : t('toggle').slice(0, 1)}
    </button>
  )
}
