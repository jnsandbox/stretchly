import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import log from 'electron-log/main.js'
import { todaysFocusUsage } from '../app/utils/focusLogSummary'

vi.mock('electron-log/main.js', () => ({ default: { warn: vi.fn() } }))

process.env.TZ = 'Europe/Amsterdam'

const midnight = Date.parse('2026-10-20T00:00:00.000+02:00')
const startedAtEight = Date.parse('2026-10-20T08:00:00.000+02:00')

let logFolder = null
let focusLogPath = null

beforeEach(async () => {
  logFolder = await mkdtemp(join(tmpdir(), 'stretchly-focus-log-summary-'))
  focusLogPath = join(logFolder, 'focus.jsonl')
  // No desktop entries, so app names fall back to the app ID.
  process.env.XDG_DATA_HOME = join(logFolder, 'data')
  process.env.XDG_DATA_DIRS = join(logFolder, 'data-dirs')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T10:00:30.000+02:00'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  await rm(logFolder, { recursive: true, force: true })
})

async function writeFocusLog (lines) {
  await writeFile(focusLogPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

function focus (clock, windowId, appId, title) {
  return { time: `2026-10-20T${clock}.000+02:00`, event: 'focus', window_id: windowId, app_id: appId, title }
}

function event (clock, name) {
  return { time: `2026-10-20T${clock}.000+02:00`, event: name }
}

function padTwo (number) {
  return String(number).padStart(2, '0')
}

function usage () {
  return todaysFocusUsage({ focusLogPath, midnight, lastBreakEnded: startedAtEight })
}

describe('today\'s usage from the focus log', () => {
  it('warns that there is no window data today when the focus log does not exist', () => {
    expect(usage()).toEqual({ warning: 'No window data today. Is the focus-log extension running?' })
  })

  it('warns that there is no window data today when the focus log stopped on an earlier day', async () => {
    await writeFocusLog([
      { time: '2026-10-19T17:00:00.000+02:00', event: 'focus', window_id: 1, app_id: 'firefox.desktop', title: 'News' }
    ])
    expect(usage()).toEqual({ warning: 'No window data today. Is the focus-log extension running?' })
  })

  it('splits VS Code time by workspace, read from the title under either app ID', async () => {
    const connectingTitle = 'dev-container+7b22686f737450617468223a222f686f6d652f6d652f64726f6e655f746f6f6c73227d'
    await writeFocusLog([
      focus('08:00:00', 1, 'code.desktop', 'break_timer - main.js - '),
      focus('08:40:00', 2, 'com.microsoft.VSCode.desktop', 'Dev Container: break_timer + Claude - break_timer - spec.md - '),
      focus('09:10:00', 3, 'code.desktop', connectingTitle),
      focus('09:30:00', 4, 'code.desktop', 'SSH: orin1 - autonomy-engine'),
      focus('09:40:00', 5, 'code.desktop', 'Visual Studio Code'),
      focus('09:45:00', 1, 'code.desktop', 'break_timer - main.js - ')
    ])
    expect(usage()).toEqual({
      activeTime: '2h 0m',
      entries: [
        { name: 'VS Code · break_timer', duration: '55m' },
        { name: 'VS Code · Dev Container: break_timer + Claude / break_timer', duration: '30m' },
        { name: 'VS Code · Dev Container (connecting): drone_tools', duration: '20m' },
        { name: 'VS Code · SSH: orin1 / autonomy-engine', duration: '10m' },
        { name: 'VS Code · (unattributed)', duration: '5m' }
      ]
    })
  })

  it('lists a Brave page with 15 minutes today on its own and sums shorter ones as other tabs', async () => {
    await writeFocusLog([
      focus('08:00:00', 1, 'brave-browser.desktop', '(3) Inbox - Brave'),
      { time: '2026-10-20T08:15:00.000+02:00', event: 'title', window_id: 1, app_id: 'brave-browser.desktop', title: 'Perception profiling comparison - Brave' },
      focus('08:29:59', 2, 'org.gnome.Terminal.desktop', 'bash'),
      focus('09:00:00', 1, 'brave-browser.desktop', 'Docs - Brave'),
      event('09:10:00', 'lock')
    ])
    expect(usage()).toEqual({
      activeTime: '1h 10m',
      entries: [
        { name: 'Terminal', duration: '30m' },
        { name: 'Brave · other tabs', duration: '24m' },
        { name: 'Brave · Inbox', duration: '15m' }
      ]
    })
  })

  it('sums all Mattermost, GitLab and Jitsi pages into one entry per site, however short each page', async () => {
    const brave = (clock, title) => ({ ...focus(clock, 1, 'brave-browser.desktop', `${title} - Brave`), event: 'title' })
    await writeFocusLog([
      focus('08:00:00', 1, 'brave-browser.desktop', 'jelmer - Ambyon Mattermost - Brave'),
      brave('08:05:00', '(2) Tooling - Ambyon Mattermost'),
      brave('08:10:00', 'Mattermost'),
      brave('08:12:00', 'Link the TensorRT major (!398) · Merge requests · Ambee / autonomy-engine · GitLab'),
      brave('08:17:00', 'Login shell startup costs 10.6 s per command (#46) · Issue · ambee/claude_issues'),
      brave('08:22:00', 'gitlab.ambee.nl/ambee/autonomy-engine/-/jobs/15656/raw'),
      brave('08:25:00', 'Sprint | Jitsi Meet'),
      brave('08:35:00', 'jitsi.ambyon.care/sprint'),
      brave('08:37:00', 'Jitsi Meet'),
      brave('08:40:00', 'WhatsApp'),
      event('08:45:00', 'lock')
    ])
    expect(usage()).toEqual({
      activeTime: '45m',
      entries: [
        { name: 'Brave · Jitsi', duration: '15m' },
        { name: 'Brave · GitLab', duration: '13m' },
        { name: 'Brave · Mattermost', duration: '12m' },
        { name: 'Brave · other tabs', duration: '5m' }
      ]
    })
  })

  it('lists the top 15 entries by desktop name, or title without an app ID, and sums the rest as Other', async () => {
    const applicationsFolder = join(logFolder, 'data', 'applications')
    await mkdir(applicationsFolder, { recursive: true })
    await writeFile(join(applicationsFolder, 'firefox.desktop'),
      '[Desktop Entry]\nName=Firefox Web Browser\nExec=firefox\n\n[Desktop Action new-window]\nName=New Window\n')
    const otherApps = Array.from({ length: 15 }, (_, index) => `app${String(index + 1).padStart(2, '0')}.desktop`)
    // Firefox first for 30 minutes, then 15 apps of 6 minutes each, the last of them ranked out.
    await writeFocusLog([
      focus('08:00:00', 1, 'firefox.desktop', 'News'),
      ...otherApps.map((appId, index) => {
        const minutes = 30 + index * 6
        return focus(`${padTwo(8 + Math.floor(minutes / 60))}:${padTwo(minutes % 60)}:00`, index + 2, appId, appId)
      }),
      event('10:00:00', 'lock')
    ])
    const { entries } = usage()
    expect(entries).toHaveLength(16)
    expect(entries[0]).toEqual({ name: 'Firefox Web Browser', duration: '30m' })
    expect(entries.slice(1, 15).every(entry => entry.duration === '6m')).toBe(true)
    expect(entries[15]).toEqual({ name: 'Other', duration: '6m' })
  })

  it('counts a second idle start at screen blank and lock, and a repeated focus line, only once', async () => {
    await writeFocusLog([
      focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash'),
      event('08:10:00', 'idle_start'),
      event('08:10:05', 'lock'),
      event('08:10:10', 'idle_start'),
      event('08:30:00', 'unlock'),
      event('08:30:01', 'idle_end'),
      focus('08:30:02', 1, 'org.gnome.Terminal.desktop', 'bash'),
      event('09:00:01', 'lock')
    ])
    expect(usage()).toEqual({ activeTime: '40m', entries: [{ name: 'Terminal', duration: '40m' }] })
  })

  it('reads only today\'s lines of a large log, counting nothing from before midnight', async () => {
    const earlierDays = ['{"time":"2026-10-18T09:00:00.000+02:00","event":"foc']
    for (let halfMinute = 0; halfMinute < 3000; halfMinute++) {
      const time = new Date(Date.parse('2026-10-18T10:00:00.000+02:00') + halfMinute * 30000).toISOString()
      earlierDays.push(JSON.stringify({ time, event: 'title', window_id: 9, app_id: 'firefox.desktop', title: `Yesterday's page ${halfMinute}` }))
    }
    earlierDays.push(JSON.stringify({ time: '2026-10-19T23:30:00.000+02:00', event: 'focus', window_id: 9, app_id: 'firefox.desktop', title: 'Late night' }))
    const today = [focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash')]
    for (let step = 1; step < 1800; step++) {
      const time = new Date(Date.parse('2026-10-20T08:00:00.000+02:00') + step * 2000).toISOString()
      today.push({ time, event: 'title', window_id: 1, app_id: 'org.gnome.Terminal.desktop', title: 'bash' })
    }
    today.push(event('09:00:00', 'lock'))
    await writeFile(focusLogPath, earlierDays.join('\n') + '\n' + today.map(line => JSON.stringify(line)).join('\n') + '\n')
    expect(usage()).toEqual({ activeTime: '1h 0m', entries: [{ name: 'Terminal', duration: '1h 0m' }] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('treats a focus log it cannot read as missing, so a break still opens', async () => {
    await mkdir(focusLogPath)
    expect(usage()).toEqual({ warning: 'No window data today. Is the focus-log extension running?' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot read focus log'))
  })

  it('keeps counting the window that had focus overnight, from the first line of today', async () => {
    await writeFocusLog([
      { time: '2026-10-19T21:30:00.000+02:00', event: 'focus', window_id: 1, app_id: 'code.desktop', title: 'drone_tools - main.py - ' },
      { time: '2026-10-19T21:40:00.000+02:00', event: 'lock' },
      { time: '2026-10-19T21:49:00.000+02:00', event: 'suspend' },
      event('08:00:00', 'resume'),
      event('08:00:10', 'unlock'),
      event('08:30:10', 'lock')
    ])
    expect(usage()).toEqual({ activeTime: '30m', entries: [{ name: 'VS Code · drone_tools', duration: '30m' }] })
  })
})
