# Volumes and backups

A site's data lives in its named volumes. `lf volume add` and `lf volume rm` declare them in your project,
and `lf volume` copies their data in and out as plain `.tar.gz` files:

```sh
lf volume add /app/data            # keep the app's /app/data across deploys (volume app-data); then lf deploy
lf volume add web:/data/content --as content     # a service of compose.yaml, with the volume's name
lf volume rm content               # unmount it again; the data stays on the server, listed as unused
lf volume rm content --data        # delete an unused volume's data (backed up first, lf undo brings it back)
lf volumes                         # the site's volumes: size, which service mounts them where, backups
lf volume backup                   # every volume to /opt/landfall/sites/<site>/backups/<volume>-<time>.tar.gz
lf volume backup content           # one volume (its name in compose.yaml, or Docker's blog_content)
lf volume pull content             # download it as ./<site>-content-<time>.tar.gz (-o file)
lf volume pull content --into ./content          # unpack into a folder, e.g. to run the site locally with its data
lf volume pull content --backup latest           # a backup instead of the live volume
lf volume push content ./content   # replace the volume with a local folder (or a .tar.gz)
lf volume restore content          # replace it with its newest backup (or name one)
lf volume backup rm content-20261027-181500.tar.gz   # delete a backup (cannot be undone)
```

The files of a volume compose.yaml declares plainly (no `external`, `driver`, `driver_opts` or `name:` of its own)
sit in the site's folder, `/opt/landfall/sites/<site>/volumes/<volume>`, next to its releases: the override binds
the named volume there (`driver_opts: {type: none, o: bind, device: …}`), so `docker volume ls`, `docker compose`
and `lf volume` work as before. `lf sites rm` keeps the folder (and the backups); `--volumes` deletes the folder and keeps the backups. `lf volume rm --data` deletes its folder too.

- `add` and `rm` edit the project in the current folder: compose.yaml gets the mount under the service and the
  volume under the top-level `volumes:` (comments and order kept, plain Compose); an app, Dockerfile or image
  keeps the path in `.landfall.json` (like `lf deploy --volume`). Neither touches the server: `lf deploy` applies
  them. `rm --data` refuses a volume a container still uses, so redeploy first.
- `push` and `restore` stop the services using the volume, back it up first (`…-before-push.tar.gz`), replace its
  contents and start them again. The step is journaled, so `lf undo` puts the previous contents back. Both ask first.
- `push` gives the files to the owner of the volume's root folder (your local uid means nothing in the container);
  `restore` keeps the owners stored in the backup.
- `backup` reads the volume while the site runs. A database container that mounts it (postgres, mysql, mariadb,
  mongo, redis, …, by its image) is paused (`docker pause`) while it is copied, and says so: its files hold still,
  a copy like after a power cut, which a database recovers from. Its requests wait meanwhile. Scheduled backups
  and `sites rm --volumes` do the same. `pull` does not pause; for a dump you can read, use the database's own
  tool (`docker compose exec db pg_dump …` in the release folder).
- `lf volume backup --schedule daily` (or `hourly`, `weekly`) backs up every volume of the site from cron and
  keeps the newest 7 per volume (`--keep 14`); `--schedule off` stops it, `lf volumes` shows the schedule and
  whether its last run failed (and for which volumes; details in `backups/backup.log`), `lf undo` restores the previous one. It writes `/opt/landfall/sites/<site>/backup.sh` and one line in the login
  user's crontab, both plain: they keep working without landfall. `--offsite backup@nas:landfall/blog` mirrors
  the backups folder's `.tar.gz` files there after each run (rsync over ssh, installed if missing; what is pruned
  here goes there too). It runs as the login user, who needs an ssh key the target accepts: `--offsite` checks
  and says so. A failed copy shows in `lf volumes` like a failed volume. The server needs a running cron daemon
  (`--schedule` warns otherwise; on Alpine, `crontab` for a non-root user needs `busybox-suid`, which
  `lf setup` installs).
- Backups made by hand are not pruned: delete them with `lf volume backup rm <file>` (or **Delete a backup…**
  in `lf ui`). `lf sites rm` keeps them with the volumes and removes the schedule; `lf sites rm --volumes` saves
  each volume as `<volume>-<time>-before-rm.tar.gz` first, deletes the volumes and journals it: `lf undo` brings
  them back. The backups stay in `/opt/landfall/sites/<site>/backups`; `lf prune --volumes` lists and deletes
  the backups of removed sites.
- After a deploy, an empty volume whose name matches a local folder the upload left out (`exclude`,
  e.g. `./content` for the volume `content`) gets an offer to push that folder into it. `lf deploy --fill-volumes`
  pushes it without asking (the deploy dialog in `lf ui` ticks this when it finds such a folder); a volume that
  already has data is never touched. Without a terminal or the flag, `lf deploy` prints the `lf volume push`
  command instead. Paths may start with `~`.
- In `lf ui`, an opened site lists its volumes (marking empty and unused ones) with **Back up**, **Restore…**, **Push…**
  and **Pull…** (the same commands; push and pull take a path on the machine running `lf ui`). For a site this
  machine deploys, **Add…** and **Remove…** run `lf volume add`/`rm` in its folder and redeploy; an unused volume
  has **Delete…**.
- Nothing here is landfall-specific. Each command prints the `docker` line it runs; by hand it is
  `docker run --rm -v blog_content:/v:ro alpine:3 tar czf - -C /v . > content.tar.gz` and back
  `docker run --rm -i -v blog_content:/v alpine:3 sh -c 'find /v -mindepth 1 -delete && tar xzf - -C /v' < content.tar.gz`.
