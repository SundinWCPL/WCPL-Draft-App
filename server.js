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
        pickTrades: {},
        timer: {
            defaultSeconds: 120,
            remainingSeconds: 120,
            running: false,
            endAt: null
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
        pickTrades: state?.pickTrades && typeof state.pickTrades === "object" && !Array.isArray(state.pickTrades)
            ? state.pickTrades
            : {},
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

    if (liveState.announcement && Number(liveState.announcement.until || 0) <= now) {
        const announcementEndedAt = Number(liveState.announcement.until || now);
        liveState.announcement = null;

        if (liveState.currentPickIndex < readDraftOrderSync().length) {
            timer.remainingSeconds = timer.defaultSeconds;
            timer.running = true;
            timer.endAt = announcementEndedAt + Number(timer.defaultSeconds || 0) * 1000;
        }
    }

    if (timer.running && timer.endAt) {
        timer.remainingSeconds = Math.max(0, Math.ceil((Number(timer.endAt) - now) / 1000));

        if (timer.remainingSeconds <= 0) {
            timer.running = false;
            timer.remainingSeconds = 0;
            timer.endAt = null;
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

        row.original_team_id = row.original_team_id || row.team_id || "";
        return row;
    });
}

function getOriginalTeamId(pick) {
    return pick?.original_team_id || pick?.team_id || "";
}

function getCurrentPickOwnerId(state, pick) {
    const originalTeamId = getOriginalTeamId(pick);
    const pickNumber = String(pick?.pick_number || "");
    return state?.pickTrades?.[pickNumber] || originalTeamId;
}

function hasPickBeenDrafted(state, pickNumber) {
    return (state?.draftedPicks || []).some(pick =>
        String(pick.pick_number) === String(pickNumber)
    );
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
    const draftOrder = readDraftOrderSync();

    const teamById = {};
    teams.forEach(team => {
        teamById[team.team_id] = team;
    });

    const orderByPickNumber = {};
    draftOrder.forEach(pick => {
        orderByPickNumber[String(pick.pick_number)] = pick;
    });

    const rows = [
        ["pick_number", "original_team_id", "original_team_name", "team_id", "team_name", "player_name"]
    ];

    state.draftedPicks.forEach(pick => {
        const orderPick = orderByPickNumber[String(pick.pick_number)] || {};
        const originalTeamId = pick.original_team_id || getOriginalTeamId(orderPick);
        const currentTeamId = pick.team_id || getCurrentPickOwnerId(state, orderPick);
        const originalTeam = teamById[originalTeamId] || {};
        const currentTeam = teamById[currentTeamId] || {};

        rows.push([
            pick.pick_number,
            originalTeamId,
            originalTeam.team_name || "",
            currentTeamId,
            currentTeam.team_name || "",
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

app.get("/api/order", (req, res) => {
    try {
        res.json(readDraftOrderSync());
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
        const draftOrder = readDraftOrderSync();

        const { pick } = req.body;

        if (!pick) {
            return res.status(400).json({ error: "Missing pick data" });
        }

        if (state.announcement && Number(state.announcement.until || 0) > Date.now()) {
            return res.status(409).json({ error: "Please wait for the current pick announcement to finish." });
        }

        const currentPick = draftOrder[state.currentPickIndex];

        if (!currentPick) {
            return res.status(400).json({ error: "Draft is already complete" });
        }

        if (String(pick.pick_number) !== String(currentPick.pick_number)) {
            return res.status(400).json({ error: "Pick number does not match the current pick" });
        }

        const teams = await readCsv(path.join(APP_DATA_DIR, "draft_teams.csv"));
        const originalTeamId = getOriginalTeamId(currentPick);
        const currentTeamId = getCurrentPickOwnerId(state, currentPick);
        const team = teams.find(row => row.team_id === currentTeamId);

        const savedPick = {
            pick_number: currentPick.pick_number,
            original_team_id: originalTeamId,
            team_id: currentTeamId,
            player_key: pick.player_key,
            player_name: pick.player_name
        };

        state.draftedPicks.push(savedPick);
        state.currentPickIndex += 1;

        state.announcement = {
            pick_number: savedPick.pick_number,
            original_team_id: savedPick.original_team_id,
            team_id: savedPick.team_id,
            team_name: team?.team_name || savedPick.team_id || "Unknown Team",
            player_name: savedPick.player_name || "",
            until: Date.now() + 10000
        };

        state.timer.running = false;
        state.timer.remainingSeconds = state.timer.defaultSeconds;
        state.timer.endAt = null;

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

app.post("/api/trade-pick", async (req, res) => {
    try {
        const state = readDraftState();
        const draftOrder = readDraftOrderSync();
        const teams = await readCsv(path.join(APP_DATA_DIR, "draft_teams.csv"));

        const { pick_number, new_team_id } = req.body || {};
        const pickNumber = String(pick_number || "").trim();
        const newTeamId = String(new_team_id || "").trim();

        if (!pickNumber || !newTeamId) {
            return res.status(400).json({ error: "Missing pick number or new team" });
        }

        const orderPick = draftOrder.find(pick =>
            String(pick.pick_number) === pickNumber
        );

        if (!orderPick) {
            return res.status(400).json({ error: "Draft pick not found" });
        }

        const newTeam = teams.find(team => team.team_id === newTeamId);

        if (!newTeam) {
            return res.status(400).json({ error: "New team not found" });
        }

        if (hasPickBeenDrafted(state, pickNumber)) {
            return res.status(400).json({ error: "Cannot trade a pick that has already been made" });
        }

        const originalTeamId = getOriginalTeamId(orderPick);

        if (newTeamId === originalTeamId) {
            delete state.pickTrades[pickNumber];
        } else {
            state.pickTrades[pickNumber] = newTeamId;
        }

        writeDraftState(state);
        res.json(readDraftState());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to trade draft pick" });
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
        state.timer.endAt = null;

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
            state.timer.endAt = now + Number(state.timer.remainingSeconds || state.timer.defaultSeconds || 0) * 1000;
        } else if (action === "pause") {
            state.timer.running = false;
            state.timer.endAt = null;
        } else if (action === "reset") {
            state.timer.running = false;
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.endAt = null;
        } else if (action === "set-length") {
            const parsedSeconds = Number(seconds);

            if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
                return res.status(400).json({ error: "Invalid timer length" });
            }

            state.timer.defaultSeconds = Math.round(parsedSeconds);
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.running = false;
            state.timer.endAt = null;
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