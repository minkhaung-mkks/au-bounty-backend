import { Router } from 'express'
import { prisma } from '../lib/prisma.js'

export const tagsRouter = Router()

// The tag list is fixed and curated. Free text would split "Thai", "thai" and
// "ภาษาไทย" into three tags that never match each other.
tagsRouter.get('/tags', async (req, res) => {
  const tags = await prisma.tag.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] })
  res.json({ tags })
})
