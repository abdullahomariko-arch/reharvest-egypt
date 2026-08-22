# Integration tests

These drive the real HTTP routes against a real Postgres, with two API instances
where concurrency is being tested. They exist because every serious defect found
in this build was invisible to unit tests:

| Defect | What unit tests said | What HTTP said |
|---|---|---|
| Same key + 10× amount returned the first response | `hashRequest` passed | 200 with the wrong order |
| One user's key returned another user's order | scoping was untested | user B got user A's order code |
| 1,000 + 1,100 never covered a 2,100 deposit | `coversDeposit` passed | order stuck in DEPOSIT_PENDING |
| One payment cleared two orders concurrently | allocation guards passed | both orders DEPOSIT_CLEARED |
| Order codes collided | never generated at volume | unique index violation |

Testing a pure helper proves the helper. It does not prove the helper is wired
to the route, that the route runs it before the operation, or that two processes
racing produce one outcome.

## Running

```bash
createdb reharvest && npm run db:migrate && npm run db:seed

# Two instances, one database.
PORT=9001 npx tsx apps/api/src/index.ts &
PORT=9002 npx tsx apps/api/src/index.ts &

npx tsx test/integration/idempotency.http.mjs   # scenarios 1, 2, 3
npx tsx test/integration/allocation.http.mjs    # scenarios 4, 5
```

Each script exits non-zero if any scenario fails, so they are usable in CI.
