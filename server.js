const express = require("express");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const APP_DATA_DIR = path.join(__dirname, "data");
const DATA_DIR = process.env.DATA_DIR || APP_DATA_DIR;

fs.mkdirSync(DATA_DIR, { recursive: true });

const statePath = path.join(DATA_DIR, "draft_state.json");
const resultsExportPath = path.join(DATA_DIR, "draft_results.csv");

function getInitialState() {
    return {
        draftedPicks: [],
        currentPickIndex: 0,
        timer: {
            defaultSeconds: 120,
            remainingSeconds: 120,
            running: false,
            lastUpdatedAt: null
        },
        announcement: null
    };
}

function normalizeDraftState(state) {
    const initial = getInitialState();

    return {
        ...initial,
        ...state,
        draftedPicks: Array.isArray(state?.draftedPicks) ? state.draftedPicks : [],
        currentPickIndex: Number(state?.currentPickIndex || 0),
        timer: {
            ...initial.timer,
            ...(state?.timer || {})
        },
        announcement: state?.announcement || null
    };
}

function computeLiveState(state) {
    const liveState = normalizeDraftState(state);
    const now = Date.now();
    const timer = liveState.timer;

    if (liveState.announcement && liveState.announcement.until <= now) {
        liveState.announcement = null;

        if (liveState.currentPickIndex < readDraftOrderSync().length) {
            timer.remainingSeconds = timer.defaultSeconds;
            timer.running = true;
            timer.lastUpdatedAt = now;
        }
    }

    if (timer.running && timer.lastUpdatedAt) {
        const elapsedSeconds = Math.floor((now - Number(timer.lastUpdatedAt)) / 1000);
        timer.remainingSeconds = Math.max(0, Number(timer.remainingSeconds || 0) - elapsedSeconds);
        timer.lastUpdatedAt = now;

        if (timer.remainingSeconds <= 0) {
            timer.running = false;
            timer.remainingSeconds = 0;
        }
    }

    return liveState;
}

function readDraftState() {
    if (!fs.existsSync(statePath)) {
        writeDraftState(getInitialState());
    }

    const raw = fs.readFileSync(statePath, "utf8");
    return computeLiveState(JSON.parse(raw));
}

function writeDraftState(state) {
    fs.writeFileSync(statePath, JSON.stringify(normalizeDraftState(state), null, 2));
}

function readDraftOrderSync() {
    const orderPath = path.join(APP_DATA_DIR, "draft_order.csv");

    if (!fs.existsSync(orderPath)) return [];

    const raw = fs.readFileSync(orderPath, "utf8").trim();
    if (!raw) return [];

    const [headerLine, ...lines] = raw.split(/\r?\n/);
    const headers = headerLine.split(",").map(h => h.trim());

    return lines.map(line => {
        const values = line.split(",");
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || "";
        });
        return row;
    });
}

app.use(express.static("public"));

function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];

        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (data) => results.push(data))
            .on("end", () => resolve(results))
            .on("error", reject);
    });
}

function escapeCsv(value) {
    const text = String(value ?? "");

    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}

async function writeDraftResultsExport(state) {
    const teams = await readCsv(path.join(APP_DATA_DIR, "draft_teams.csv"));

    const teamById = {};
    teams.forEach(team => {
        teamById[team.team_id] = team;
    });

    const rows = [
        ["pick_number", "team_id", "team_name", "player_name"]
    ];

    state.draftedPicks.forEach(pick => {
        const team = teamById[pick.team_id] || {};

        rows.push([
            pick.pick_number,
            pick.team_id,
            team.team_name || "",
            pick.player_name || ""
        ]);
    });

    const csvText = rows
        .map(row => row.map(escapeCsv).join(","))
        .join("\n");

    fs.writeFileSync(
        resultsExportPath,
        csvText
    );
}

app.get("/api/players", async (req, res) => {
    try {
        const players = await readCsv(path.join(APP_DATA_DIR, "draft_players.csv"));
        res.json(players);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read players file" });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { password } = req.body;

        const users = await readCsv(path.join(APP_DATA_DIR, "draft_users.csv"));

        const user = users.find(row =>
            row.enabled === "TRUE" &&
            row.password === password
        );

        if (!user) {
            return res.status(401).json({ error: "Invalid password" });
        }

        res.json({
            role: user.role,
            team_id: user.team_id,
            display_name: user.display_name
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to log in" });
    }
});

app.get("/api/player-stats", async (req, res) => {
    try {
        const stats = await readCsv(path.join(APP_DATA_DIR, "draft_player_stats.csv"));
        res.json(stats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read player stats file" });
    }
});

app.get("/api/teams", async (req, res) => {
    try {
        const teams = await readCsv(path.join(APP_DATA_DIR, "draft_teams.csv"));
        res.json(teams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read teams file" });
    }
});

app.get("/api/order", async (req, res) => {
    try {
        const order = await readCsv(path.join(APP_DATA_DIR, "draft_order.csv"));
        res.json(order);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read draft order file" });
    }
});

app.get("/api/state", (req, res) => {
    try {
        const state = readDraftState();
        res.json(state);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read draft state" });
    }
});

app.post("/api/export-results", async (req, res) => {
    try {
        const state = readDraftState();

        await writeDraftResultsExport(state);

        res.json({
            success: true,
            message: `Draft results exported to ${resultsExportPath}`
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to export draft results" });
    }
});

app.post("/api/pick", async (req, res) => {
    try {
        const state = readDraftState();

        const { pick } = req.body;

        if (!pick) {
            return res.status(400).json({ error: "Missing pick data" });
        }

        state.draftedPicks.push(pick);
        state.currentPickIndex += 1;

        const draftOrder = await readCsv(path.join(APP_DATA_DIR, "draft_order.csv"));
        const teams = await readCsv(path.join(APP_DATA_DIR, "draft_teams.csv"));
        const team = teams.find(row => row.team_id === pick.team_id);

        state.announcement = {
            pick_number: pick.pick_number,
            team_id: pick.team_id,
            team_name: team?.team_name || pick.team_id || "Unknown Team",
            player_name: pick.player_name || "",
            until: Date.now() + 10000
        };

        state.timer.running = false;
        state.timer.remainingSeconds = state.timer.defaultSeconds;
        state.timer.lastUpdatedAt = null;

        if (state.currentPickIndex >= draftOrder.length) {
            state.announcement = null;
            state.timer.running = false;
            await writeDraftResultsExport(state);
        }

        writeDraftState(state);

        res.json(readDraftState());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to save pick" });
    }
});

app.post("/api/reset", (req, res) => {
    try {
        const state = getInitialState();
        writeDraftState(state);
        res.json(state);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to reset draft" });
    }
});

app.post("/api/undo", (req, res) => {
    try {
        const state = readDraftState();

        if (state.draftedPicks.length > 0) {
            state.draftedPicks.pop();

            if (state.currentPickIndex > 0) {
                state.currentPickIndex -= 1;
            }
        }

        state.announcement = null;
        state.timer.running = false;
        state.timer.remainingSeconds = state.timer.defaultSeconds;
        state.timer.lastUpdatedAt = null;

        writeDraftState(state);

        res.json(readDraftState());

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to undo pick" });
    }
});

app.post("/api/timer", (req, res) => {
    try {
        const state = readDraftState();
        const { action, seconds } = req.body || {};
        const now = Date.now();

        if (action === "start") {
            state.announcement = null;
            state.timer.running = true;
            state.timer.lastUpdatedAt = now;
        } else if (action === "pause") {
            state.timer.running = false;
            state.timer.lastUpdatedAt = null;
        } else if (action === "reset") {
            state.timer.running = false;
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.lastUpdatedAt = null;
        } else if (action === "set-length") {
            const parsedSeconds = Number(seconds);

            if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
                return res.status(400).json({ error: "Invalid timer length" });
            }

            state.timer.defaultSeconds = Math.round(parsedSeconds);
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.running = false;
            state.timer.lastUpdatedAt = null;
        } else {
            return res.status(400).json({ error: "Invalid timer action" });
        }

        writeDraftState(state);
        res.json(readDraftState());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update timer" });
    }
});

app.listen(PORT, () => {
    console.log(`Draft app running at http://localhost:${PORT}`);
});