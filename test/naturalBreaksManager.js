import { vi } from 'vitest'
import 'chai/register-should'
import { powerMonitor } from 'electron'
import { join } from 'path'
import NaturalBreaksManager from '../app/utils/naturalBreaksManager'
import Store from 'electron-store'
import defaultSettings from '../app/utils/defaultSettings'
import { rm } from 'node:fs/promises'

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: vi.fn(() => 0) } }))

describe('naturalBreaksManager', function () {
  let settings = null
  let naturalBreaksManager = null

  beforeEach(() => {
    settings = new Store({
      cwd: join(__dirname),
      name: 'test-settings-naturalBreaksManager',
      defaults: defaultSettings
    })
    naturalBreaksManager = new NaturalBreaksManager(settings)
  })

  it('should be running with default settings', () => {
    naturalBreaksManager.isOnNaturalBreak.should.be.equal(false)
    naturalBreaksManager.isSchedulerCleared.should.be.equal(false)
    naturalBreaksManager.usingNaturalBreaks.should.be.equal(true)
  })

  it('should not be running with naturalBreaks: false', () => {
    settings.set('naturalBreaks', false)
    naturalBreaksManager.stop()
    naturalBreaksManager = null
    naturalBreaksManager = new NaturalBreaksManager(settings)
    naturalBreaksManager.isOnNaturalBreak.should.be.equal(false)
    naturalBreaksManager.isSchedulerCleared.should.be.equal(false)
    naturalBreaksManager.usingNaturalBreaks.should.be.equal(false)
  })

  it('should be running with naturalBreaks: true', () => {
    settings.set('naturalBreaks', true)
    naturalBreaksManager.stop()
    naturalBreaksManager = null
    naturalBreaksManager = new NaturalBreaksManager(settings)
    naturalBreaksManager.isOnNaturalBreak.should.be.equal(false)
    naturalBreaksManager.isSchedulerCleared.should.be.equal(false)
    naturalBreaksManager.usingNaturalBreaks.should.be.equal(true)
  })

  it('should start when start()', () => {
    naturalBreaksManager.stop()
    naturalBreaksManager.start()
    naturalBreaksManager.isOnNaturalBreak.should.be.equal(false)
    naturalBreaksManager.isSchedulerCleared.should.be.equal(false)
    naturalBreaksManager.usingNaturalBreaks.should.be.equal(true)
  })

  it('should stop when stop()', async () => {
    naturalBreaksManager.stop()
    naturalBreaksManager.usingNaturalBreaks.should.be.equal(false)
    naturalBreaksManager.isSchedulerCleared.should.be.equal(false)
    naturalBreaksManager.isOnNaturalBreak.should.be.equal(false)
    ;(await naturalBreaksManager.readIdleTime()).should.be.equal(0)
  })

  it('does not create a second timer when start() is called twice', () => {
    naturalBreaksManager.stop()
    naturalBreaksManager.start()
    const timer = naturalBreaksManager.timer
    naturalBreaksManager.start()
    naturalBreaksManager.timer.should.be.equal(timer)
  })

  describe('idle time source', () => {
    const checkInterval = defaultSettings.naturalBreaksCheckInterval
    const longerThanResetTime = defaultSettings.naturalBreaksInactivityResetTime + 60000

    function managerWithGnomeIdleTime (gnomeIdleMilliseconds) {
      naturalBreaksManager.stop()
      naturalBreaksManager = new NaturalBreaksManager(settings, {
        idleMilliseconds: async () => gnomeIdleMilliseconds
      })
      return naturalBreaksManager
    }

    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('clears the schedule when GNOME reports the user away, whatever Electron reports', async () => {
      powerMonitor.getSystemIdleTime.mockReturnValue(0)
      const manager = managerWithGnomeIdleTime(longerThanResetTime)
      await vi.advanceTimersByTimeAsync(checkInterval)
      manager.isSchedulerCleared.should.be.equal(true)
    })

    it('keeps the schedule when GNOME reports the user active, whatever Electron reports', async () => {
      powerMonitor.getSystemIdleTime.mockReturnValue(longerThanResetTime / 1000)
      const manager = managerWithGnomeIdleTime(1000)
      await vi.advanceTimersByTimeAsync(checkInterval)
      manager.isSchedulerCleared.should.be.equal(false)
    })

    it('falls back to Electron\'s idle time when GNOME does not answer', async () => {
      powerMonitor.getSystemIdleTime.mockReturnValue(longerThanResetTime / 1000)
      const manager = managerWithGnomeIdleTime(null)
      await vi.advanceTimersByTimeAsync(checkInterval)
      manager.isSchedulerCleared.should.be.equal(true)
    })

    it('keeps checking after a check fails to read the idle time', async () => {
      powerMonitor.getSystemIdleTime.mockImplementationOnce(() => { throw new Error('no idle time') })
      powerMonitor.getSystemIdleTime.mockReturnValue(longerThanResetTime / 1000)
      const manager = managerWithGnomeIdleTime(null)
      await vi.advanceTimersByTimeAsync(2 * checkInterval)
      manager.isSchedulerCleared.should.be.equal(true)
    })
  })

  afterEach(async () => {
    naturalBreaksManager.stop()
    naturalBreaksManager = null

    if (settings) {
      await rm(join(__dirname, '/test-settings-naturalBreaksManager.json'), { force: true })
      settings = null
    }
  })
})
