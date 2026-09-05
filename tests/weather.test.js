import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { appWith, createUser, resetDb } from './helpers.js'
import { currentWeather, resetWeatherCache, labelForCode } from '../src/lib/weather.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith({ dev: true })

const savedEnv = {}
const setEnv = (name, value) => {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const openMeteoOk = (temperature_2m = 31.4, weather_code = 2) =>
  new Response(JSON.stringify({ current: { temperature_2m, weather_code } }), { status: 200 })

beforeEach(async () => {
  resetWeatherCache()
  setEnv('WEATHER_LAT', '13.6146')
  setEnv('WEATHER_LON', '100.7121')
  setEnv('WEATHER_LABEL', 'Bang Na')
  await resetDb()
})

afterEach(() => {
  resetWeatherCache()
  vi.unstubAllGlobals()
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('GET /weather', () => {
  test('answers Open-Meteo current conditions for the campus point', async () => {
    const fetchMock = vi.fn(async () => openMeteoOk(31.4, 2))
    vi.stubGlobal('fetch', fetchMock)
    const user = await createUser()

    const res = await request(app).get(`${api}/weather`).set(dev(user))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      temperatureC: 31.4,
      weatherCode: 2,
      label: 'Partly cloudy',
      locationLabel: 'Bang Na',
    })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?')
    expect(url).toContain('latitude=13.6146')
    expect(url).toContain('longitude=100.7121')
    expect(url).toContain('current=temperature_2m%2Cweather_code')
  })

  test('a second call inside the TTL is served from cache with no fetch', async () => {
    const fetchMock = vi.fn(async () => openMeteoOk(29.9, 0))
    vi.stubGlobal('fetch', fetchMock)
    const user = await createUser()

    await request(app).get(`${api}/weather`).set(dev(user))
    await request(app).get(`${api}/weather`).set(dev(user))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a fetch failure serves the stale cache instead of erroring', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openMeteoOk(28.1, 95)))
    expect(await currentWeather()).toMatchObject({ temperatureC: 28.1, label: 'Thunderstorm' })

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    await expect(currentWeather()).resolves.toMatchObject({ temperatureC: 28.1 })
  })

  test('degrades to 503 with an empty cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    const user = await createUser()

    const res = await request(app).get(`${api}/weather`).set(dev(user))
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('WEATHER_UNAVAILABLE')
  })

  test('requires a session', async () => {
    const res = await request(app).get(`${api}/weather`)
    expect(res.status).toBe(401)
  })
})

describe('WMO code labels', () => {
  test('maps the handful of codes the chip shows', () => {
    expect(labelForCode(0)).toBe('Clear')
    expect(labelForCode(3)).toBe('Overcast')
    expect(labelForCode(45)).toBe('Fog')
    expect(labelForCode(61)).toBe('Rain')
    expect(labelForCode(71)).toBe('Snow')
    expect(labelForCode(95)).toBe('Thunderstorm')
    expect(labelForCode(1234)).toBe('Unsettled')
  })
})
