import log from 'electron-log/main.js'

const activityCheckMilliseconds = 5000
// Input this recent counts as the user being active.
const activeIdleMilliseconds = 20000
// Activity this long while away means an unlock or a wake went unreported; typing a
// password at the lock screen takes less.
const missedEndActiveMilliseconds = 60000

// A spell away runs while the screen is locked or the system is suspended, from whichever
// came first until both have ended. One that lasts naturalBreaksInactivityResetTime counts
// as a break; a shorter one leaves the schedule as it was. While away, a break that comes due
// or a popup that runs out waits for the end of the spell.
// Electron and GNOME can both report one screen lock, so a repeated lock is ignored.
class AwayBreaks {
  // readIdleMilliseconds reads the system idle time, whether or not natural breaks are on.
  constructor ({ settings, breakPlanner, breakLog, closeBreakPopup, readIdleMilliseconds, updateTray }) {
    this.settings = settings
    this.breakPlanner = breakPlanner
    this.breakLog = breakLog
    this.closeBreakPopup = closeBreakPopup
    this.readIdleMilliseconds = readIdleMilliseconds
    this.updateTray = updateTray
    this.isScreenLocked = false
    this.isSuspended = false
    this.spell = null
    this.activityCheckTimer = null
    this.isReadingIdle = false
    this.isWatchingGnome = false
    this.onSuspended = () => this.suspendChanged(true)
    this.onResumed = () => this.suspendChanged(false)
    this.onScreenLocked = () => this.screenLockChanged(true)
    this.onScreenUnlocked = () => this.screenLockChanged(false)
    breakPlanner.on('naturalBreakCleared', () => {
      if (this.spell) this.spell.naturalBreakCleared = true
    })
    // Input at the lock screen can end a natural break while the user is still away.
    breakPlanner.on('naturalBreakRestarted', () => {
      if (this.spell) this.holdSchedule()
    })
  }

  // Safe to call again: listeners are replaced, and GNOME is only watched once.
  listen (powerMonitor, gnomeSession) {
    powerMonitor.removeListener('suspend', this.onSuspended)
    powerMonitor.removeListener('lock-screen', this.onScreenLocked)
    powerMonitor.removeListener('resume', this.onResumed)
    powerMonitor.removeListener('unlock-screen', this.onScreenUnlocked)
    powerMonitor.on('suspend', this.onSuspended)
    powerMonitor.on('lock-screen', this.onScreenLocked)
    powerMonitor.on('resume', this.onResumed)
    powerMonitor.on('unlock-screen', this.onScreenUnlocked)
    if (!this.isWatchingGnome) {
      this.isWatchingGnome = true
      // Electron sees no screen lock when running on the X11 backend under GNOME.
      gnomeSession.watchScreenLock(isLocked => this.screenLockChanged(isLocked))
    }
  }

  screenLockChanged (isLocked) {
    log.info(`System: screen ${isLocked ? 'locked' : 'unlocked'}`)
    if (isLocked === this.isScreenLocked) {
      // An unlock that ends no lock ends no spell; timers may still have stalled.
      if (!isLocked) this.correctSchedule()
      return
    }
    this.isScreenLocked = isLocked
    this.awayChanged('lock')
  }

  suspendChanged (isSuspended) {
    log.info(`System: ${isSuspended ? 'suspend' : 'resume'}`)
    if (isSuspended === this.isSuspended) {
      if (!isSuspended) this.correctSchedule()
      return
    }
    this.isSuspended = isSuspended
    this.awayChanged('suspend')
  }

  awayChanged (cause, changedAt = Date.now()) {
    const isAway = this.isScreenLocked || this.isSuspended
    if (isAway && !this.spell) {
      // Wall-clock time, because idle time and timers stall across a suspend.
      this.spell = { cause, startedAt: changedAt, naturalBreakCleared: false, activeSince: null }
      this.activityCheckTimer = setInterval(() => this.checkForActivity(), activityCheckMilliseconds)
      this.holdSchedule()
    } else if (!isAway && this.spell) {
      const spell = this.spell
      this.spell = null
      clearInterval(this.activityCheckTimer)
      this.activityCheckTimer = null
      if (this.settings.get('pauseForSuspendOrLock')) this.breakPlanner.naturalBreaksManager.countIdleFrom(changedAt)
      this.endSpell(spell, changedAt)
    }
  }

  // Ends a spell whose unlock or wake never arrived at the time the user came back, so it
  // stretches over no later activity and a later lock is not taken as a repeat.
  async checkForActivity () {
    if (this.isReadingIdle) return
    this.isReadingIdle = true
    let idleMilliseconds
    try {
      idleMilliseconds = await this.readIdleMilliseconds()
    } catch {
      return
    } finally {
      this.isReadingIdle = false
    }
    const spell = this.spell
    if (!spell || idleMilliseconds === null || idleMilliseconds === undefined) return
    const lastInputAt = Date.now() - idleMilliseconds
    if (idleMilliseconds >= activeIdleMilliseconds || lastInputAt < spell.startedAt) {
      spell.activeSince = null
      return
    }
    spell.activeSince ??= lastInputAt
    if (Date.now() - spell.activeSince >= missedEndActiveMilliseconds) {
      log.info('Stretchly: active for a minute while away, so the unlock or wake was missed')
      this.isScreenLocked = false
      this.isSuspended = false
      this.awayChanged(spell.cause, spell.activeSince)
    }
  }

  endSpell ({ cause, startedAt, naturalBreakCleared }, endedAt) {
    const awayMilliseconds = endedAt - startedAt
    if (!this.settings.get('pauseForSuspendOrLock') ||
      awayMilliseconds < this.settings.get('naturalBreaksInactivityResetTime') ||
      naturalBreakCleared || !this.isScheduleRunning()) {
      this.correctSchedule()
      return
    }
    this.breakLog.recordAwayBreak({
      awayMilliseconds, cause, scheduledBreakType: this.breakPlanner.plannedBreakType
    })
    this.closeBreakPopup()
    this.breakPlanner.reset()
    log.info(`Stretchly: restarting breaks after ${Math.round(awayMilliseconds / 1000)}s away`)
    this.updateTray()
  }

  // A break coming due, or a popup running out, waits until the user is back.
  holdSchedule () {
    if (this.settings.get('pauseForSuspendOrLock')) this.breakPlanner.holdScheduler()
  }

  // A natural break, Do Not Disturb, an app exclusion or a pause owns the restart of a stopped schedule.
  isScheduleRunning () {
    const breakPlanner = this.breakPlanner
    return !breakPlanner.isPaused && !breakPlanner.dndManager.isOnDnd &&
      !breakPlanner.naturalBreaksManager.isSchedulerCleared &&
      !breakPlanner.appExclusionsManager.isSchedulerCleared
  }

  // Brings forward a break that came due while timers were stalled or held.
  // A held schedule stays held until the spell ends.
  correctSchedule () {
    if (this.spell) return
    this.breakPlanner.correctScheduler()
    this.updateTray()
  }
}

export default AwayBreaks
