-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailOutbox_sentAt_createdAt_idx" ON "EmailOutbox"("sentAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_kind_refId_key" ON "EmailOutbox"("kind", "refId");
