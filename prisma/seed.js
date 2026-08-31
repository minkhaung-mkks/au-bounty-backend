import { prisma } from '../src/lib/prisma.js'

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
const daysAhead = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000)

const TAGS = [
  ['Thai', 'LANGUAGE'],
  ['English', 'LANGUAGE'],
  ['Burmese', 'LANGUAGE'],
  ['Chinese', 'LANGUAGE'],
  ['Math', 'ACADEMIC'],
  ['Tutoring', 'ACADEMIC'],
  ['Research', 'ACADEMIC'],
  ['Writing', 'ACADEMIC'],
  ['Design', 'PRACTICAL'],
  ['Coding', 'PRACTICAL'],
  ['Photography', 'PRACTICAL'],
  ['Logistics', 'PRACTICAL'],
  ['Delivery', 'ERRAND'],
  ['Queueing', 'ERRAND'],
  ['Survey', 'ERRAND'],
  ['Moving', 'ERRAND'],
]

async function main() {
  // Order matters: children before parents.
  await prisma.attachment.deleteMany()
  await prisma.message.deleteMany()
  await prisma.review.deleteMany()
  await prisma.taskAssignment.deleteMany()
  await prisma.taskTag.deleteMany()
  await prisma.userTag.deleteMany()
  await prisma.emergencyAlert.deleteMany()
  await prisma.task.deleteMany()
  await prisma.orgMembership.deleteMany()
  await prisma.organization.deleteMany()
  await prisma.tag.deleteMany()
  await prisma.user.deleteMany()

  const tags = {}
  for (const [name, category] of TAGS) {
    tags[name] = await prisma.tag.create({ data: { name, category } })
  }

  const orgA = await prisma.organization.create({
    data: { name: 'Organization A', description: 'Placeholder student organization.' },
  })
  await prisma.organization.create({
    data: { name: 'Organization B', description: 'Second placeholder organization.' },
  })

  const mk = (name, email, universityId, role, bio) =>
    prisma.user.create({ data: { name, email, universityId, role, bio } })

  // One user per role, plus two extra students so applicants and reviewers exist.
  const student = await mk('Student One', 'student.one@example.edu', '6700001', 'STUDENT',
    'Placeholder bio for the default student account.')
  const orgMember = await mk('Org Member Two', 'org.member.two@example.edu', '6700002', 'STUDENT',
    'Student who belongs to Organization A and can post events for it.')
  const teacher = await mk('Teacher Three', 'teacher.three@example.edu', '6700003', 'TEACHER',
    'Teacher account. Can offer extra credit as a reward.')
  const admin = await mk('Admin Four', 'admin.four@example.edu', '6700004', 'ADMIN',
    'Administrator account.')
  const studentFive = await mk('Student Five', 'student.five@example.edu', '6700005', 'STUDENT', null)
  const studentSix = await mk('Student Six', 'student.six@example.edu', '6700006', 'STUDENT', null)

  // Owns tasks created by the partner alert system. No interactive login.
  const service = await mk('Partner Alert System', 'service@sl-systems.example', null, 'SERVICE',
    'Peer API service account.')

  await prisma.orgMembership.create({
    data: { userId: orgMember.id, orgId: orgA.id, position: 'Events lead' },
  })

  const tagUser = (user, names) =>
    prisma.userTag.createMany({
      data: names.map((n) => ({ userId: user.id, tagId: tags[n].id })),
    })

  await tagUser(student, ['Thai', 'Burmese', 'Coding', 'Tutoring'])
  await tagUser(studentFive, ['Math', 'Tutoring', 'Survey'])
  await tagUser(studentSix, ['English', 'Logistics'])
  await tagUser(orgMember, ['Design', 'Photography'])

  const task = async (data, tagNames = []) => {
    const t = await prisma.task.create({ data })
    if (tagNames.length) {
      await prisma.taskTag.createMany({
        data: tagNames.map((n) => ({ taskId: t.id, tagId: tags[n].id })),
      })
    }
    return t
  }

  // --- Open request with two applicants waiting on the default user's approval.
  const t1 = await task(
    {
      title: 'Request task A',
      content:
        'Placeholder request with two spots and apply-and-approve acceptance. The poster picks who gets in.',
      type: 'REQUEST',
      posterId: student.id,
      rewardType: 'CASH',
      rewardDescription: '200 THB',
      maxTakers: 2,
      acceptanceMode: 'APPROVAL',
      locationName: 'Building A, ground floor',
      locationLat: 13.6122,
      locationLng: 100.8368,
      deadline: daysAhead(5),
      createdAt: daysAgo(2),
    },
    ['Thai', 'Survey'],
  )
  await prisma.taskAssignment.createMany({
    data: [
      { taskId: t1.id, takerId: studentFive.id, status: 'APPLIED', appliedAt: daysAgo(1) },
      { taskId: t1.id, takerId: studentSix.id, status: 'APPLIED', appliedAt: daysAgo(1) },
    ],
  })

  // --- Assignment mid-flight: the default user is helping with someone else's task.
  const t2 = await task(
    {
      title: 'Request task B',
      content: 'Placeholder request the default user has already been accepted onto.',
      type: 'REQUEST',
      posterId: studentFive.id,
      status: 'LOCKED',
      rewardType: 'CASH',
      rewardDescription: '600 THB',
      maxTakers: 1,
      acceptanceMode: 'AUTO',
      locationName: 'Library, third floor',
      createdAt: daysAgo(4),
    },
    ['Math', 'Tutoring'],
  )
  await prisma.taskAssignment.create({
    data: { taskId: t2.id, takerId: student.id, status: 'IN_PROGRESS', appliedAt: daysAgo(3) },
  })

  // --- Completed task the default user still owes a review on.
  const t3 = await task(
    {
      title: 'Request task C',
      content: 'Placeholder request that finished. Both sides may now review each other.',
      type: 'REQUEST',
      posterId: studentSix.id,
      status: 'COMPLETED',
      rewardType: 'OTHER',
      rewardDescription: 'A favour',
      maxTakers: 1,
      acceptanceMode: 'AUTO',
      locationName: 'Cafeteria, Building C',
      createdAt: daysAgo(9),
    },
    ['Logistics'],
  )
  await prisma.taskAssignment.create({
    data: {
      taskId: t3.id,
      takerId: student.id,
      status: 'COMPLETED',
      appliedAt: daysAgo(8),
      completionRequestedAt: daysAgo(6),
      completedAt: daysAgo(5),
    },
  })

  // --- Two finished tasks that already produced published reviews.
  const history = [
    { poster: studentFive, title: 'Request task D', rating: 5, text: 'Placeholder five-star review text.' },
    { poster: studentSix, title: 'Request task E', rating: 4, text: 'Placeholder four-star review text.' },
  ]
  for (const [i, h] of history.entries()) {
    const t = await task(
      {
        title: h.title,
        content: 'Placeholder request that completed and was reviewed.',
        type: 'REQUEST',
        posterId: h.poster.id,
        status: 'COMPLETED',
        rewardType: 'CASH',
        rewardDescription: '150 THB',
        maxTakers: 1,
        acceptanceMode: 'AUTO',
        locationName: 'Building D',
        createdAt: daysAgo(20 + i * 5),
      },
      ['Coding'],
    )
    await prisma.taskAssignment.create({
      data: {
        taskId: t.id,
        takerId: student.id,
        status: 'COMPLETED',
        appliedAt: daysAgo(19 + i * 5),
        completionRequestedAt: daysAgo(18 + i * 5),
        completedAt: daysAgo(18 + i * 5),
      },
    })
    await prisma.review.createMany({
      data: [
        {
          taskId: t.id,
          reviewerId: h.poster.id,
          revieweeId: student.id,
          rating: h.rating,
          text: h.text,
          published: true,
          createdAt: daysAgo(17 + i * 5),
        },
        {
          taskId: t.id,
          reviewerId: student.id,
          revieweeId: h.poster.id,
          rating: 5,
          text: 'Placeholder review written by the default user.',
          published: true,
          createdAt: daysAgo(17 + i * 5),
        },
      ],
    })
  }

  // --- Events.
  const eventA = await task(
    {
      title: 'Event task A',
      content: 'Placeholder organization event. Reserve a seat, then check in at the door.',
      type: 'EVENT',
      posterId: orgMember.id,
      orgId: orgA.id,
      rewardType: 'OTHER',
      rewardDescription: 'Bonus points',
      maxTakers: 120,
      acceptanceMode: 'AUTO',
      locationName: 'Auditorium, Building E',
      startsAt: daysAhead(3),
      checkinSecret: 'SEEDSECRETA',
      createdAt: daysAgo(6),
    },
    ['Design'],
  )
  await prisma.taskAssignment.createMany({
    data: [studentFive, studentSix, orgMember].map((u) => ({
      taskId: eventA.id,
      takerId: u.id,
      status: 'ACCEPTED',
      appliedAt: daysAgo(2),
    })),
  })

  await task(
    {
      title: 'Event task B',
      content: 'Placeholder teacher-run event worth extra credit for attendees who check in.',
      type: 'EVENT',
      posterId: teacher.id,
      rewardType: 'EXTRA_CREDIT',
      rewardDescription: '+5 extra score',
      maxTakers: 120,
      acceptanceMode: 'AUTO',
      locationName: 'Room 402, Building F',
      startsAt: daysAhead(6),
      checkinSecret: 'SEEDSECRETB',
      createdAt: daysAgo(3),
    },
    ['Research'],
  )

  // --- Emergencies. One arrived through the peer API, one was posted by a student.
  await task(
    {
      title: 'Emergency task A',
      content:
        'Placeholder emergency created by the partner alert system through the peer API. Deduplicated on externalRef.',
      type: 'EMERGENCY',
      posterId: service.id,
      externalRef: 'sl-systems-alert-0001',
      rewardType: 'NONE',
      rewardDescription: '',
      maxTakers: 3,
      acceptanceMode: 'AUTO',
      locationName: 'Sports complex',
      createdAt: new Date(Date.now() - 8 * 60 * 1000),
    },
    ['Thai', 'English'],
  )
  await task(
    {
      title: 'Emergency task B',
      content: 'Placeholder urgent request posted by a student.',
      type: 'EMERGENCY',
      posterId: studentSix.id,
      rewardType: 'CASH',
      rewardDescription: '300 THB',
      maxTakers: 2,
      acceptanceMode: 'AUTO',
      locationName: 'Hall, Building G',
      createdAt: new Date(Date.now() - 22 * 60 * 1000),
    },
    ['Logistics'],
  )

  const counts = {
    users: await prisma.user.count(),
    orgs: await prisma.organization.count(),
    tags: await prisma.tag.count(),
    tasks: await prisma.task.count(),
    assignments: await prisma.taskAssignment.count(),
    reviews: await prisma.review.count(),
  }
  console.log('Seeded:', counts)
  console.log('Default login: Student One')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
