# WCPL Draft App - Railway Deploy Notes

## What is already ready

This app is ready for Railway with:

- `npm start` -> `node server.js`
- `server.js` listening on `process.env.PORT || 3000`
- static frontend served from `/public`
- read-only draft setup CSV files bundled in `/data`
- writable draft state/results redirected through `DATA_DIR`

## Persistent storage setup

The app now separates bundled draft setup files from writable draft files.

Bundled files stay in the repo under:

- `data/draft_players.csv`
- `data/draft_player_stats.csv`
- `data/draft_teams.csv`
- `data/draft_order.csv`
- `data/draft_users.csv`

Writable files are stored in:

- `process.env.DATA_DIR` when set
- otherwise local `data/` when running on your computer

Writable files:

- `draft_state.json`
- `draft_results.csv`

## Railway steps

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from that GitHub repo.
3. Add a Railway Volume.
4. Mount the Volume at `/data`.
5. Add this environment variable:

```txt
DATA_DIR=/data
```

6. Deploy the service.
7. Open the service settings and generate a public domain.
8. Test login, picking, undo, reset, export, then redeploy/restart and confirm the state stayed saved.

## Local testing

Run normally:

```bash
npm install
npm start
```

Optional local persistence test with a custom data folder:

```bash
DATA_DIR=./local_persist npm start
```

On Windows PowerShell:

```powershell
$env:DATA_DIR = "./local_persist"
npm start
```

## Live viewer/captain update patch

This version includes shared server-side timer state and automatic browser polling.

- Browsers poll `/api/state` every 1 second.
- Commissioner timer controls write to `/api/timer`.
- The timer countdown is calculated on the server, so viewers/captains stay in sync.
- Pick announcements are stored in shared state for 10 seconds, then the next pick timer starts automatically.
