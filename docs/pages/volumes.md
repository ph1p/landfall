# Volumes and backups

A site's data lives in its named volumes.
`lf volume add` and `lf volume rm` declare them in your project.
`lf volume` copies their data in and out as plain `.tar.gz` files.

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

## Where the data lives

A volume declared plainly (no `external`, `driver`, `driver_opts` or own `name:`) lives in `/opt/landfall/sites/<site>/volumes/<volume>`, next to the releases.
The override binds it there (`driver_opts: {type: none, o: bind, device: …}`), so `docker volume ls`, `docker compose` and `lf volume` work as before.
`lf sites rm` keeps the folder and backups; `--volumes` deletes the folder, keeping backups. `lf volume rm --data` deletes it too.

## Add and remove

`add` and `rm` edit the project in the current folder, not the server; `lf deploy` applies them.

- compose.yaml gets the mount under the service and the volume under top-level `volumes:` (comments and order kept, plain Compose).
- An app, Dockerfile or image keeps the path in `.landfall.json`, like `lf deploy --volume`.
- `rm --data` refuses a volume a container still uses: redeploy first.

## Push and restore

`push` and `restore` ask first, then stop the services using the volume, back it up (`…-before-push.tar.gz`),
replace its contents and start the services again.
The step is journaled, so `lf undo` puts the previous contents back.

`push` gives the files to the owner of the volume's root folder (your local uid means nothing there). `restore` keeps the backup's owners.

## Backups of a running database

`backup` reads the volume while the site runs.
A database container mounting it (by image: postgres, mysql, mariadb, mongo, redis, …) is paused (`docker pause`) during the copy, and says so.
Its files hold still, like after a power cut, which a database recovers from. Its requests wait.
Scheduled backups and `sites rm --volumes` do the same; `pull` does not pause.
For a readable dump, use the database's own tool (`docker compose exec db pg_dump …` in the release folder).

## Scheduled backups

```sh
lf volume backup --schedule daily --keep 14      # every volume from cron (or hourly, weekly); newest 14 kept (default 7)
lf volume backup --schedule off
```

- It writes `/opt/landfall/sites/<site>/backup.sh` and a line in the login user's crontab, both plain: they work without landfall.
- `lf volumes` shows the schedule and whether its last run failed, for which volumes (details in `backups/backup.log`). `lf undo` restores the previous one.
- It needs a running cron daemon (`--schedule` warns). On Alpine, a non-root `crontab` needs `busybox-suid`, which `lf setup` installs.
- `--offsite backup@nas:landfall/blog` mirrors the backups' `.tar.gz` files there after each run, by rsync over ssh (installed if missing). Pruning applies there too.
- The mirror runs as the login user, who needs an ssh key the target accepts; `--offsite` checks. A failed copy shows in `lf volumes` like a failed volume.

## Keeping and deleting backups

- Manual backups are not pruned: delete them with `lf volume backup rm <file>` or **Delete a backup…** in `lf ui`.
- `lf sites rm` removes the schedule. `--volumes` first saves each volume as `<volume>-<time>-before-rm.tar.gz` and journals the removal, so `lf undo` brings them back.
- Backups stay in `/opt/landfall/sites/<site>/backups`. `lf prune --volumes` lists and deletes those of removed sites.

## Filling a new volume on deploy

After a deploy, `lf deploy` offers to push a folder the upload left out (`exclude`) into an empty volume of that name, like `./content` into `content`.
`--fill-volumes` pushes without asking (the `lf ui` deploy dialog ticks it when it finds such a folder).
A volume with data is never touched. Without a terminal or the flag, it prints the `lf volume push` command. Paths may start with `~`.

## In the web UI

An opened site lists its volumes, marking empty and unused ones.
**Back up**, **Restore…**, **Push…** and **Pull…** run the same commands; push and pull take a path on the `lf ui` machine.
For a site this machine deploys, **Add…** and **Remove…** run `lf volume add`/`rm` in its folder and redeploy. An unused volume has **Delete…**.

## Without landfall

Each command prints the `docker` line it runs. By hand:

```sh
docker run --rm -v blog_content:/v:ro alpine:3 tar czf - -C /v . > content.tar.gz   # back up a volume
docker run --rm -i -v blog_content:/v alpine:3 sh -c 'find /v -mindepth 1 -delete && tar xzf - -C /v' < content.tar.gz   # restore it
```
