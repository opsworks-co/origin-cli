-- CreateTable
CREATE TABLE "SessionAnnotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionAnnotation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionAnnotation_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionAnnotation_sessionId_idx" ON "SessionAnnotation"("sessionId");

-- CreateIndex
CREATE INDEX "SessionAnnotation_authorId_idx" ON "SessionAnnotation"("authorId");
