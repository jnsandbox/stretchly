import { vi, expect } from 'vitest'
import { pauseSubmenu } from '../app/utils/pauseMenu'

describe('pauseSubmenu', () => {
  const i18next = { t: (key, { count }) => `${count} minutes` }

  function submenuWith (shortcuts = {}) {
    const pauseBreaks = vi.fn()
    const settings = { get: (name) => shortcuts[name] ?? '' }
    return { submenu: pauseSubmenu({ settings, i18next, pauseBreaks }), pauseBreaks }
  }

  it('offers pauses of 10, 20 and 30 minutes and nothing else', () => {
    const { submenu } = submenuWith()
    expect(submenu.map(item => item.label)).toEqual(['10 minutes', '20 minutes', '30 minutes'])
  })

  it('pauses for the length each item names', () => {
    const { submenu, pauseBreaks } = submenuWith()
    for (const item of submenu) item.click()
    expect(pauseBreaks.mock.calls).toEqual([[10 * 60 * 1000], [20 * 60 * 1000], [30 * 60 * 1000]])
  })

  it('shows the 30-minute pause shortcut beside its item', () => {
    const { submenu } = submenuWith({ pauseBreaksFor30MinutesShortcut: 'Ctrl+Shift+P' })
    expect(submenu.map(item => item.accelerator)).toEqual([null, null, 'Ctrl+Shift+P'])
  })
})
