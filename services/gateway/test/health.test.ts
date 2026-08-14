import { describe, expect, it } from 'vitest'
import { testApp } from './helpers.js'

describe('build provenance', () => {
  it('/health reports sha + builtAt ("unknown" when the image is unstamped)', async () => {
    const { app } = await testApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    // sha/builtAt prove from outside which build is running — the deploy
    // verification the fleet script and the eval harness both read.
    expect(res.json()).toMatchObject({
      ok: true,
      service: 'gateway',
      sha: expect.any(String),
      builtAt: expect.any(String),
    })
    await app.close()
  })
})
