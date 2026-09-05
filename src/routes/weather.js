import { Router } from 'express'
import { requireUser } from '../middleware/auth.js'
import { currentWeather } from '../lib/weather.js'

export const weatherRouter = Router()

// D11: the campus weather chip. Always mounted (Open-Meteo needs no key); the
// only failure mode is a 503 when the API is down and nothing is cached, which
// the frontend renders with its placeholder text.
weatherRouter.get('/weather', requireUser, async (req, res) => {
  res.json(await currentWeather())
})
