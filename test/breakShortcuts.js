import { vi } from 'vitest'
import { expect } from 'chai'
import { calculateInterval, registerBreakShortcuts, setupBreak, onShortcut } from '../app/utils/breakShortcuts'

describe('pauseBreaksShortcut', () => {
  describe('calculateInterval', () => {
    it('should return correct interval for pauseBreaksFor30MinutesShortcut', () => {
      const interval = calculateInterval('pauseBreaksFor30MinutesShortcut')
      expect(interval).toBe(30 * 60 * 1000)
    })
  })

  describe('onShortcut', () => {
    it('calls pauseBreaks for pauseBreaksFor30MinutesShortcut', () => {
      const log = { info: vi.fn() }
      const pauseBreaks = vi.fn()

      onShortcut({
        name: 'pauseBreaksFor30MinutesShortcut',
        settings: null,
        breakPlanner: null,
        functions: { pauseBreaks },
        log
      })

      expect(pauseBreaks).toHaveBeenCalledWith(30 * 60 * 1000)
      expect(log.info).toHaveBeenCalledWith('Stretchly: pausing breaks by shortcut (pauseBreaksFor30MinutesShortcut)')
    })

    describe('skipToNextScheduledBreakShortcut', () => {
      it('skips to next scheduled break', () => {
        const log = { info: vi.fn() }
        const skipToBreak = vi.fn()
        const skipToMicrobreak = vi.fn()
        const pauseBreaks = vi.fn()
        const breakPlanner = { _scheduledBreakType: 'break' }

        onShortcut({
          name: 'skipToNextScheduledBreakShortcut',
          settings: null,
          breakPlanner,
          functions: { skipToBreak, skipToMicrobreak, pauseBreaks },
          log
        })

        expect(log.info).toHaveBeenCalledWith('Stretchly: skipping to next scheduled break by shortcut')
        expect(skipToBreak).toHaveBeenCalled()
        expect(skipToMicrobreak).not.toHaveBeenCalled()
        expect(pauseBreaks).not.toHaveBeenCalled()
      })

      it('skips to next scheduled microbreak', () => {
        const log = { info: vi.fn() }
        const skipToBreak = vi.fn()
        const skipToMicrobreak = vi.fn()
        const pauseBreaks = vi.fn()
        const breakPlanner = { _scheduledBreakType: 'microbreak' }

        onShortcut({
          name: 'skipToNextScheduledBreakShortcut',
          settings: null,
          breakPlanner,
          functions: { skipToBreak, skipToMicrobreak, pauseBreaks },
          log
        })

        expect(log.info).toHaveBeenCalledWith('Stretchly: skipping to next scheduled break by shortcut')
        expect(skipToBreak).not.toHaveBeenCalled()
        expect(skipToMicrobreak).toHaveBeenCalled()
        expect(pauseBreaks).not.toHaveBeenCalled()
      })
    })

    describe('skipToNextLongBreakShortcut', () => {
      it('skips to next scheduled long break', () => {
        const log = { info: vi.fn() }
        const skipToBreak = vi.fn()
        const pauseBreaks = vi.fn()

        onShortcut({
          name: 'skipToNextLongBreakShortcut',
          settings: null,
          breakPlanner: null,
          functions: { skipToBreak, pauseBreaks },
          log
        })

        expect(log.info).toHaveBeenCalledWith('Stretchly: skipping to next Long break by shortcut')
        expect(skipToBreak).toHaveBeenCalled()
        expect(pauseBreaks).not.toHaveBeenCalled()
      })
    })

    describe('skipToNextMiniBreakShortcut', () => {
      it('skips to next scheduled microbreak', () => {
        const log = { info: vi.fn() }
        const skipToMicrobreak = vi.fn()
        const pauseBreaks = vi.fn()

        onShortcut({
          name: 'skipToNextMiniBreakShortcut',
          settings: null,
          breakPlanner: null,
          functions: { skipToMicrobreak, pauseBreaks },
          log
        })

        expect(log.info).toHaveBeenCalledWith('Stretchly: skipping to next Mini break by shortcut')
        expect(skipToMicrobreak).toHaveBeenCalled()
        expect(pauseBreaks).not.toHaveBeenCalled()
      })
    })
  })

  describe('setupBreak', () => {
    it('should register a shortcut and call pauseBreaks with the correct interval', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(true) }
      const log = { info: vi.fn(), warn: vi.fn() }
      const pauseBreaks = vi.fn()

      setupBreak({
        name: 'pauseBreaksFor30MinutesShortcut',
        shortcutText: 'Ctrl+Shift+P',
        settings: null,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: { pauseBreaks }
      })

      expect(globalShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+P', expect.any(Function))
      globalShortcut.register.mock.calls[0][1]()
      expect(pauseBreaks).toHaveBeenCalledWith(30 * 60 * 1000)
      expect(log.info).toHaveBeenCalledWith('Stretchly: pauseBreaksFor30MinutesShortcut registration successful (Ctrl+Shift+P)')
    })

    it('should log a warning if shortcut registration fails', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(false) }
      const log = { info: vi.fn(), warn: vi.fn() }
      const pauseBreaks = vi.fn()

      setupBreak({
        name: 'pauseBreaksFor30MinutesShortcut',
        shortcutText: 'Ctrl+Shift+P',
        settings: null,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: { pauseBreaks }
      })

      expect(log.warn).toHaveBeenCalledWith('Stretchly: pauseBreaksFor30MinutesShortcut registration failed')
    })
  })

  describe('registerBreakShortcuts', () => {
    it('should register all shortcuts from settings', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(true) }
      const log = { info: vi.fn(), warn: vi.fn() }
      const pauseBreaks = vi.fn()

      const intervals = {
        pauseBreaksFor30MinutesShortcut: 0,
        skipToNextScheduledBreakShortcut: 1,
        skipToNextMiniBreakShortcut: 2,
        skipToNextLongBreakShortcut: 3
      }

      const settings = { get: vi.fn((name) => intervals[name]) }

      registerBreakShortcuts({
        settings,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: { pauseBreaks }
      })

      // Check shortcut registration
      // ------------

      expect(globalShortcut.register).toHaveBeenCalledTimes(4)

      for (let i = 0; i < 4; i++) {
        expect(globalShortcut.register.mock.calls[i][0]).toBe(i)
      }

      // Check log
      // ------------

      expect(log.info).toHaveBeenCalledTimes(4)

      for (let i = 0; i < 4; i++) {
        expect(log.info.mock.calls[i][0]).toMatch(`registration successful (${i})`)
      }
    })

    it('does not register a reset shortcut, so breaks cannot be reset by keyboard', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(true) }
      const log = { info: vi.fn(), warn: vi.fn() }

      const settings = { get: vi.fn((name) => name === 'resetBreaksShortcut' ? 'key' : '') }

      registerBreakShortcuts({
        settings,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: {}
      })

      expect(globalShortcut.register).not.toHaveBeenCalled()
    })

    it('registers no shortcut that pauses longer than 30 minutes or indefinitely', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(true) }
      const log = { info: vi.fn(), warn: vi.fn() }
      const removedShortcuts = [
        'pauseBreaksFor1HourShortcut',
        'pauseBreaksFor2HoursShortcut',
        'pauseBreaksFor5HoursShortcut',
        'pauseBreaksUntilMorningShortcut',
        'pauseBreaksToggleShortcut'
      ]

      const settings = { get: vi.fn((name) => removedShortcuts.includes(name) ? 'key' : '') }

      registerBreakShortcuts({
        settings,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: {}
      })

      expect(globalShortcut.register).not.toHaveBeenCalled()
    })

    it('should skip empty shortcuts', () => {
      const globalShortcut = { register: vi.fn().mockReturnValue(true) }
      const log = { info: vi.fn(), warn: vi.fn() }
      const pauseBreaks = vi.fn()

      const settings = { get: vi.fn((name) => name === 'pauseBreaksFor30MinutesShortcut' ? 'key' : '') }

      registerBreakShortcuts({
        settings,
        log,
        globalShortcut,
        breakPlanner: null,
        functions: { pauseBreaks }
      })

      expect(globalShortcut.register).toHaveBeenCalledTimes(1)
      expect(globalShortcut.register).toHaveBeenCalledWith('key', expect.any(Function))
      expect(log.info).toHaveBeenCalledTimes(1)
      expect(log.info).toHaveBeenCalledWith('Stretchly: pauseBreaksFor30MinutesShortcut registration successful (key)')
    })
  })
})
