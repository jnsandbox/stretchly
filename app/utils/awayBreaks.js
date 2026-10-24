import log from 'electron-log/main.js'

const spellCheckMilliseconds = 5000
// This long between two checks, against an interval of spellCheckMilliseconds, means the
// machine slept and woke.
const sleptGapMilliseconds = 30000

// A spell away runs while the screen is locked or the system is suspended, from whichever
// came first until both have ended. One that lasts naturalBreaksInactivityResetTime counts
// as a break; a shorter one leaves the schedule as it was. While away, a break that comes due
// or a popup that runs out waits for the end of the spell.
// Electron and GNOME can both report one screen lock, so a repeated lock is ignored.
class AwayBreaks {
  constructor ({ settings, breakPlanner, breakLog, closeBreakPopup, updateTray }) {
    this.settings = settings
    this.breakPlanner = breakPlanner
    this.breakLog = breakLog
    this.closeBreakPopup = closeBreakPopup
    this.updateTray = updateTray
    this.gnomeSession = null
    this.isScreenLocked = false
    this.isSuspended = false
    this.spell = null
    this.spellCheckTimer = null
    this.lastSpellCheckAt = null
    this.isReadingLockState = false
    this.isWatchingGnome = false
    this.onSuspended = () => this.suspendChanged(true)
    this.onResumed = () => this.suspendChanged(false)
    this.onScreenLocked = () => this.screenLockChanged(true)
    this.onScreenUnlocked = () => this.screenLockChanged(false)
    breakPlanner.on('naturalBreakCleared', () => {
      if (this.spell) this.spell.naturalBreakCleared = true
    })
  }

  // Safe to call again: listeners are replaced, and GNOME is only watched once.
  listen (powerMonitor, gnomeSession) {
    this.gnomeSession = gnomeSession
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
      gnomeSession.watchScreenLock(isLocked => this.screenLockChanged(isLocked, { isFromGnome: true }))
    }
  }

  screenLockChanged (isLocked, { isFromGnome = false } = {}) {
    log.info(`System: screen ${isLocked ? 'locked' : 'unlocked'}`)
    if (isLocked === this.isScreenLocked) {
      if (isLocked && isFromGnome) this.spell.gnomeReportedLock = true
      // An unlock that ends no lock ends no spell; timers may still have stalled.
      if (!isLocked) this.correctSchedule()
      return
    }
    this.isScreenLocked = isLocked
    this.awayChanged('lock')
    if (isLocked && isFromGnome) this.spell.gnomeReportedLock = true
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

  awayChanged (cause) {
    const isAway = this.isScreenLocked || this.isSuspended
    const changedAt = Date.now()
    if (isAway && !this.spell) {
      // Wall-clock time, because idle time and timers stall across a suspend.
      this.spell = { cause, startedAt: changedAt, naturalBreakCleared: false, gnomeReportedLock: false }
      this.lastSpellCheckAt = changedAt
      this.spellCheckTimer = setInterval(() => this.checkForMissedEnd(), spellCheckMilliseconds)
      if (this.settings.get('pauseForSuspendOrLock')) this.breakPlanner.holdSchedules()
    } else if (!isAway && this.spell) {
      const spell = this.spell
      this.spell = null
      clearInterval(this.spellCheckTimer)
      this.spellCheckTimer = null
      if (this.settings.get('pauseForSuspendOrLock')) this.breakPlanner.naturalBreaksManager.countIdleFrom(changedAt)
      this.endSpell(spell, changedAt)
    }
  }

  // Catches a wake or an unlock that was never reported, so a spell does not stretch over
  // later work and a later lock is not taken as a repeat. A missed unlock is caught only
  // where GNOME answers for its lock state.
  async checkForMissedEnd () {
    const checkedAt = Date.now()
    const sinceLastCheck = checkedAt - this.lastSpellCheckAt
    this.lastSpellCheckAt = checkedAt
    if (this.isSuspended && sinceLastCheck >= sleptGapMilliseconds) {
      log.info('Stretchly: woke from suspend without a resume event')
      this.suspendChanged(false)
    }
    if (!this.isScreenLocked || !this.gnomeSession || this.isReadingLockState) return
    this.isReadingLockState = true
    const spellAtRead = this.spell
    try {
      const isLocked = await this.gnomeSession.isScreenLocked()
      // An answer that outlived its spell describes a lock that is over.
      if (this.spell !== spellAtRead || !this.isScreenLocked) return
      if (isLocked === true) {
        spellAtRead.gnomeReportedLock = true
      } else if (isLocked === false && spellAtRead.gnomeReportedLock) {
        // Without GNOME's own lock behind it, unlocked may only mean another locker is running.
        log.info('Stretchly: GNOME reads unlocked without an unlock event')
        this.screenLockChanged(false)
      }
    } finally {
      this.isReadingLockState = false
    }
  }

  endSpell ({ cause, startedAt, naturalBreakCleared }, endedAt) {
    const awayMilliseconds = endedAt - startedAt
    this.breakPlanner.releaseSchedules()
    if (!this.settings.get('pauseForSuspendOrLock') ||
      awayMilliseconds < this.settings.get('naturalBreaksInactivityResetTime') ||
      naturalBreakCleared || !this.isScheduleRunning()) {
      this.updateTray()
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

  // A natural break, Do Not Disturb, an app exclusion or a pause owns the restart of a stopped schedule.
  isScheduleRunning () {
    const breakPlanner = this.breakPlanner
    return !breakPlanner.isPaused && !breakPlanner.dndManager.isOnDnd &&
      !breakPlanner.naturalBreaksManager.isSchedulerCleared &&
      !breakPlanner.appExclusionsManager.isSchedulerCleared
  }

  // Brings forward a break that came due while timers were stalled.
  // A held schedule stays held until the spell ends.
  correctSchedule () {
    if (this.spell) return
    this.breakPlanner.correctScheduler()
    this.updateTray()
  }
}

export default AwayBreaks
