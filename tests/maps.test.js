import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith({ dev: true })

// Maps env is read at call time; keep each test hermetic against backend/.env.
const savedEnv = {}
const setEnv = (name, value) => {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

let poster
let tagId

beforeEach(async () => {
  setEnv('GOOGLE_MAPS_KEY', undefined)
  await resetDb()
  poster = await createUser({ name: 'Map Poster' })
  const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ERRAND' } })
  tagId = tag.id
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const create = (body) =>
  request(app)
    .post(`${api}/tasks`)
    .set(dev(poster))
    .send({
      title: 'Deliver a parcel',
      content: 'Small box across campus',
      type: 'REQUEST',
      tagIds: [tagId],
      ...body,
    })

// Google geocode answer for whatever address was requested.
const geocodeOk = (lat, lng) =>
  new Response(
    JSON.stringify({
      status: 'OK',
      results: [{ geometry: { location: { lat, lng } } }],
    }),
    { status: 200 },
  )
const geocodeEmpty = () =>
  new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 })

describe('POST /tasks location resolution', () => {
  test('a keyed geocode fills coordinates and a static map URL', async () => {
    setEnv('GOOGLE_MAPS_KEY', 'maps-test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => geocodeOk(13.6128, 100.7146)),
    )

    const res = await create({ locationName: 'Canteen B' })
    expect(res.status).toBe(201)
    expect(res.body.task.location).toEqual({
      name: 'Canteen B',
      lat: 13.6128,
      lng: 100.7146,
      mapUrl: expect.stringContaining('https://maps.googleapis.com/maps/api/staticmap'),
    })
    expect(res.body.task.location.mapUrl).toContain('center=13.6128%2C100.7146')
    expect(res.body.task.location.mapUrl).toContain('key=maps-test-key')
  })

  test('geocode failure with manual coordinates is accepted, mapUrl derived when keyed', async () => {
    setEnv('GOOGLE_MAPS_KEY', 'maps-test-key')
    vi.stubGlobal('fetch', vi.fn(async () => geocodeEmpty()))

    const res = await create({ locationName: 'Somewhere unlisted', locationLat: 13.61, locationLng: 100.72 })
    expect(res.status).toBe(201)
    expect(res.body.task.location).toEqual({
      name: 'Somewhere unlisted',
      lat: 13.61,
      lng: 100.72,
      mapUrl: expect.stringContaining('staticmap'),
    })
    const stored = await prisma.task.findUnique({ where: { id: res.body.task.id } })
    expect(stored.mapUrl).toBe(res.body.task.location.mapUrl)
  })

  test('without a key, manual coordinates are the fallback and no mapUrl is derived', async () => {
    const res = await create({ locationName: 'Dorm A', locationLat: 13.6135, locationLng: 100.7152 })
    expect(res.status).toBe(201)
    expect(res.body.task.location).toEqual({ name: 'Dorm A', lat: 13.6135, lng: 100.7152, mapUrl: null })
  })

  test('a location name with neither geocode nor manual coordinates is 400 LOCATION_UNRESOLVED', async () => {
    const res = await create({ locationName: 'Nowhere' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LOCATION_UNRESOLVED')
    expect(await prisma.task.count()).toBe(0)

    // Same answer when Google is keyed but cannot resolve the name.
    setEnv('GOOGLE_MAPS_KEY', 'maps-test-key')
    vi.stubGlobal('fetch', vi.fn(async () => geocodeEmpty()))
    expect((await create({ locationName: 'Nowhere at all' })).body.error.code).toBe('LOCATION_UNRESOLVED')
  })

  test('a geocode outage never blocks creation when manual coordinates are supplied', async () => {
    setEnv('GOOGLE_MAPS_KEY', 'maps-test-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Error('network down')))

    const res = await create({ locationName: 'Canteen B', locationLat: 13.6128, locationLng: 100.7146 })
    expect(res.status).toBe(201)
    expect(res.body.task.location).toEqual({
      name: 'Canteen B',
      lat: 13.6128,
      lng: 100.7146,
      mapUrl: expect.stringContaining('staticmap'),
    })
  })

  test('no locationName means nothing is required', async () => {
    const res = await create({ title: 'Deliver a parcel', locationName: undefined })
    expect(res.status).toBe(201)
    expect(res.body.task.location).toEqual({ name: '', lat: null, lng: null, mapUrl: null })
  })

  test('half a coordinate pair fails validation', async () => {
    expect((await create({ locationName: 'Dorm A', locationLat: 13.6 })).status).toBe(400)
    expect((await create({ locationLat: 91, locationLng: 100.7, locationName: 'Dorm A' })).status).toBe(400)
  })
})

describe('PATCH /tasks location edit', () => {
  test('a new locationName reruns the full resolution', async () => {
    const created = await create({ locationName: 'Dorm A', locationLat: 13.6135, locationLng: 100.7152 })
    expect(created.status).toBe(201)

    setEnv('GOOGLE_MAPS_KEY', 'maps-test-key')
    vi.stubGlobal('fetch', vi.fn(async () => geocodeOk(13.6128, 100.7146)))

    const res = await request(app)
      .patch(`${api}/tasks/${created.body.task.id}`)
      .set(dev(poster))
      .send({ locationName: 'Canteen B' })
    expect(res.status).toBe(200)
    expect(res.body.task.location).toEqual({
      name: 'Canteen B',
      lat: 13.6128,
      lng: 100.7146,
      mapUrl: expect.stringContaining('staticmap'),
    })
    expect(res.body.task.location.mapUrl).toContain('staticmap')
  })

  test('a coords-only edit fixes the pin without touching the name', async () => {
    const created = await create({ locationName: 'Dorm A', locationLat: 13.6135, locationLng: 100.7152 })
    const res = await request(app)
      .patch(`${api}/tasks/${created.body.task.id}`)
      .set(dev(poster))
      .send({ locationLat: 13.61, locationLng: 100.71 })
    expect(res.status).toBe(200)
    expect(res.body.task.location).toEqual({ name: 'Dorm A', lat: 13.61, lng: 100.71, mapUrl: null })
  })

  test('editing the name without resolvable coordinates is 400 LOCATION_UNRESOLVED', async () => {
    const created = await create({ locationName: 'Dorm A', locationLat: 13.6135, locationLng: 100.7152 })
    const res = await request(app)
      .patch(`${api}/tasks/${created.body.task.id}`)
      .set(dev(poster))
      .send({ locationName: 'Somewhere else' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LOCATION_UNRESOLVED')
  })
})
