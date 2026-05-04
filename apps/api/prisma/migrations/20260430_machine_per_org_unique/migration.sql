-- Drop global uniqueness on Machine.machineId and replace with a composite
-- (machineId, orgId) unique constraint. The same physical machine can fan
-- sessions out to multiple orgs (one CLI install with multiple profiles),
-- and the old global key silently dropped registrations to every org
-- after the first — sessions still landed but no Machine row was created.

-- SQLite stores the @unique as a unique index, so this is a pure index
-- swap (no table rebuild, no data movement).
DROP INDEX IF EXISTS "Machine_machineId_key";

CREATE UNIQUE INDEX "Machine_machineId_orgId_key" ON "Machine"("machineId", "orgId");
