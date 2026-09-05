import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith({ dev: true })

const savedEnv = {}
const setEnv = (name, value) => {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

let user
let task

beforeEach(async () => {
  setEnv('GOOGLE_TRANSLATE_KEY', undefined)
  await resetDb()
  user = await createUser({ name: 'Translator' })
  const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'LANGUAGE' } })
  task = await prisma.task.create({
    data: {
      title: 'Carry boxes downstairs',
      content: 'Two hours of lifting',
      type: 'REQUEST',
      posterId: user.id,
      tags: { create: [{ tagId: tag.id }] },
    },
  })
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

const translate = (lang, id = task.id) =>
  request(app).post(`${api}/tasks/${id}/translate?lang=${lang}`).set(dev(user))

describe('POST /tasks/:id/translate', () => {
  test('without a key the identity fallback echoes the original strings', async () => {
    const res = await translate('th')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      title: 'Carry boxes downstairs',
      content: 'Two hours of lifting',
      translated: false,
    })
  })

  test('with a key Google translates title and content', async () => {
    setEnv('GOOGLE_TRANSLATE_KEY', 'translate-test-key')
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              translations: [
                { translatedText: 'ยกกล่องลงบันได', detectedSourceLanguage: 'en' },
                { translatedText: 'ยกของสองชั่วโมง', detectedSourceLanguage: 'en' },
              ],
            },
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await translate('th')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      title: 'ยกกล่องลงบันได',
      content: 'ยกของสองชั่วโมง',
      translated: true,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://translation.googleapis.com/language/translate/v2?key=translate-test-key')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      q: ['Carry boxes downstairs', 'Two hours of lifting'],
      target: 'th',
      format: 'text',
    })
  })

  test('a Google failure degrades to identity instead of erroring', async () => {
    setEnv('GOOGLE_TRANSLATE_KEY', 'translate-test-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const res = await translate('th')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      title: 'Carry boxes downstairs',
      content: 'Two hours of lifting',
      translated: false,
    })
  })

  test('requires a valid two-letter lang, auth, and an existing task', async () => {
    expect((await translate('thai')).status).toBe(400)
    expect((await translate('t1')).status).toBe(400)
    expect((await translate('')).status).toBe(400)
    expect(
      (
        await request(app)
          .post(`${api}/tasks/${task.id}/translate?lang=th`)
      ).status,
    ).toBe(401)
    expect((await translate('th', crypto.randomUUID())).status).toBe(404)
  })
})
