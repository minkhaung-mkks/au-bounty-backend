import { ApiError } from './errors.js'

/**
 * D11 weather chip. Open-Meteo current conditions for the campus point
 * (WEATHER_LAT/WEATHER_LON, default Bang Na), cached in memory for 10 minutes.
 * When the fetch fails, a cached reading is served stale rather than erroring;
 * with nothing cached the caller gets a 503 and keeps its placeholder text.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const WEATHER_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 10 * 60 * 1000

// WMO weather interpretation codes, grouped to the labels the chip shows.
const CODE_LABELS = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
}

export const labelForCode = (code) => CODE_LABELS[code] ?? 'Unsettled'

let cache = null // { at, data }

/** Test hook: drop the cached reading so a fresh fetch happens. */
export function resetWeatherCache() {
  cache = null
}

/**
 * Returns { temperatureC, weatherCode, label, locationLabel }, fresh from
 * Open-Meteo or the last cached reading. Throws ApiError 503
 * (WEATHER_UNAVAILABLE) only when the API is unreachable with an empty cache.
 */
export async function currentWeather() {
  const locationLabel = process.env.WEATHER_LABEL || 'Campus'
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  const lat = process.env.WEATHER_LAT || '13.6146'
  const lon = process.env.WEATHER_LON || '100.7121'
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,weather_code',
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS)
  try {
    const response = await fetch(`${FORECAST_URL}?${params.toString()}`, {
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`open-meteo answered ${response.status}`)
    const data = await response.json()
    const current = data?.current
    if (typeof current?.temperature_2m !== 'number' || typeof current?.weather_code !== 'number') {
      throw new Error('unexpected open-meteo body')
    }
    const weather = {
      temperatureC: current.temperature_2m,
      weatherCode: current.weather_code,
      label: labelForCode(current.weather_code),
      locationLabel,
    }
    cache = { at: Date.now(), data: weather }
    return weather
  } catch (err) {
    if (cache) return cache.data // stale beats a broken chip
    throw new ApiError(
      503,
      'WEATHER_UNAVAILABLE',
      'Weather is unavailable right now. Try again in a moment.',
      { reason: err.message },
    )
  } finally {
    clearTimeout(timeout)
  }
}
