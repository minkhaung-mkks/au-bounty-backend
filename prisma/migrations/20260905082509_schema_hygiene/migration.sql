-- CreateIndex
CREATE INDEX "EmergencyAlert_status_createdAt_idx" ON "EmergencyAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Message_assignmentId_createdAt_idx" ON "Message"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_posterId_idx" ON "Task"("posterId");

-- AddCheckConstraint
-- Prisma cannot model CHECK constraints, so these live only in this file
-- (noted in schema.prisma next to the affected models).

-- Review.rating must be a 1..5 star value.
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5);

-- An attachment belongs to exactly one of a task or a message, never both, never neither.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_task_or_message_check" CHECK (num_nonnulls("taskId", "messageId") = 1);
