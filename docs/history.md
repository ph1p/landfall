# History and undo

Every change landfall makes is appended to `/opt/landfall/journal.log` on the server: when, which local user and
command, what changed and the shell that reverts it.

```sh
lf history -s vps       # newest first; ↺ undoable, · not undoable, ✓ already undone
lf undo -s vps          # revert the latest run with something left to undo
lf undo 4               # run #4
lf undo 4.2             # only its second step
lf undo --all           # everything, newest first
```

- **Undoable:** setup (packages and Docker stay installed), firewall rules and on/off, deploys and rollbacks
  (previous release and env), env and secret changes, stop/start, domains, logins, Traefik setup, `traefik use` and `traefik rm`, image and
  compose updates.
- **Not undoable:** `sites rm` (its volumes are: `--volumes` backs them up first), `volume backup rm`, restarts, package upgrades, and a firewall rule that replaced an existing one.
- Steps revert newest first, each as the user that made it. The first failure stops the rest.
- Undoing an older run is refused while a later run still changed the same site, Traefik or file: undo the
  later one first, or pass `--force`.
- Undo changes the server only. Local `~/.config/landfall` and `.landfall.json` stay as they are.
- Overwritten files are backed up as `.<name>.landfall-<run>-<n>`, and the newest 10 are kept per file.
- Two undos at once on the same server wait for each other, and a step already undone is skipped.
