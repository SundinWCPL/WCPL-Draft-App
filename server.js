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
        currentPickIndex: 0
    };
}

function readDraftState() {
    if (!fs.existsSync(statePath)) {
        writeDraftState(getInitialState());
    }

    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw);
}

function writeDraftState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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

        if (state.currentPickIndex >= draftOrder.length) {
            await writeDraftResultsExport(state);
        }

        writeDraftState(state);

        res.json(state);
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

        writeDraftState(state);

        res.json(state);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to undo pick" });
    }
});

app.listen(PORT, () => {
    console.log(`Draft app running at http://localhost:${PORT}`);
});