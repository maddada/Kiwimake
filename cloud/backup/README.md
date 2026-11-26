# Kiwimake Cloud backups (Convex Starter)

Convex Starter keeps no periodic backups ("Periodic backups require a Convex Pro plan",
https://docs.convex.dev/database/backup-restore), so we keep our own: every day at 03:17 UTC a
GitHub Actions job in a **private** repo runs `npx convex export` against the production
deployment, checks the ZIP has the `users`, `apps` and `keys` tables, encrypts it to our backup
public key and keeps it as a release of that repo. Backups older than **30 days** are deleted, but
the newest 7 always stay. File storage (APKs, icons, page files) is left out by default: builds
are made again from each app's GitHub repo; set `BACKUP_INCLUDE_FILES=1` to add it.

Each export also leaves a snapshot in the Convex dashboard, which Convex keeps for up to 7 days
(at most two per deployment on Starter). So data stays in backups for at most 30 days.

A deployment with no tables at all (never deployed to) gives a warning and no backup, and the
backups already kept stay; one with tables but without `users`, `apps` or `keys` fails the run, so
a wrong deploy key is noticed (GitHub emails the owner).

## Setting it up (once)

1. Make the backup key on a trusted PC: `node kiwi-backup.mjs keygen --out kiwimake-backup.key`.
   It prints the public key (`KWBK-PUBLIC-1:...`). Put the private key file in 1Password
   (`Kiwimake Cloud backup key`) and delete the file. Without it no backup can be read.
2. Make a private repo, for example `kiwimake-backups`, with `kiwi-backup.mjs`, `package.json`,
   `package-lock.json` from this folder and `github-workflow.yml` as
   `.github/workflows/convex-backup.yml`.
3. In the Convex dashboard, the production deployment's settings, Deploy keys: a key that may
   export data. Save it as the repo secret `CONVEX_PROD_EXPORT_KEY`. Save the public key as the
   repo variable `BACKUP_PUBLIC_KEY`.
4. Run the workflow once by hand (Actions, Convex backup, Run workflow) and check a release
   `backup-<date>` appears.

## Restoring

1. Download the `.kwb` asset of the release you want.
2. `node kiwi-backup.mjs restore --key kiwimake-backup.key --in <file>.kwb --out snapshot.zip`
3. Take a fresh backup of the target deployment first (restores are destructive), then
   `npx convex import --replace-all snapshot.zip` with that deployment's deploy key in
   `CONVEX_DEPLOY_KEY`.

Tests: `node --test cloud/backup/kiwi-backup.test.mjs`.
