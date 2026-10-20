import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import Store from 'electron-store'
import BreaksPlanner from '../app/breaksPlanner'
import defaultSettings from '../app/utils/defaultSettings'

describe('breaksPlanner', () => {
  let settingsFolder = null
  let breaksPlanner = null

  beforeEach(async () => {
    vi.useFakeTimers()
    settingsFolder = await mkdtemp(join(tmpdir(), 'stretchly-breaks-planner-'))
    const settings = new Store({ cwd: settingsFolder, name: 'settings', defaults: defaultSettings })
    settings.set('naturalBreaks', false)
    settings.set('monitorDnd', false)
    breaksPlanner = new BreaksPlanner(settings)
    breaksPlanner.nextBreak()
  })

  afterEach(async () => {
    breaksPlanner.clear()
    vi.useRealTimers()
    await rm(settingsFolder, { recursive: true, force: true })
  })

  it('counts the postpones of the break due next', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.postponeCurrentBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(2)
  })

  it('starts the postpone count again for the next planned break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.nextBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })

  it('starts the postpone count again when skipping ahead to a Mini break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.skipToMicrobreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })

  it('starts the postpone count again when skipping ahead to a Long break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.skipToBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })
})
