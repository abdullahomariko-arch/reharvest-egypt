# Database invariant proofs

`invariants.proof.sql` asserts that the constraints in `migrations/0001_invariants.sql`
actually refuse the things they are supposed to refuse. It is run against a real
Postgres, because a CHECK constraint that was never exercised is a comment.

```bash
createdb reharvest
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/0000_init.sql \
  -f packages/db/migrations/0001_invariants.sql \
  -f packages/db/test/invariants.proof.sql
```

Every check raises `PASS` on the refusal it expects and aborts with `FAIL` if the
database lets the bad row through. A non-zero exit means an invariant regressed.

What it proves, and why each one matters:

| Test | Rule | What it stops |
|---|---|---|
| 1 | D14 | Reserving 900kg against an 800kg lot — the double-sell |
| 2 | D14 | A legitimate reservation still works (a constraint that blocks everything is useless) |
| 3 | D34 | Empty crates weighing more than the load — the wrong crate template |
| 4 | D34 | A net weight that is not gross minus tare — a fudged settlement figure |
| 5 | D34 | A correct weighing is accepted |
| 6 | D53 | Editing a recorded weight after settlement |
| 7 | D53 | Deleting a recorded weight |
| 8 | D47 | A retried request being recorded as a second delivery |
