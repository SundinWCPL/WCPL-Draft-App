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

        // Freeze the clock at the time the pick was made during the 10-second announcement.
        // computeLiveState() will reset/start the next pick timer when the announcement ends.
        state.timer.running = false;
        state.timer.remainingSeconds = Math.max(0, Number(state.timer.remainingSeconds || 0));
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


// ---------------- Mock Draft Rooms ----------------
const mockRoomsDir = path.join(DATA_DIR, "mock_rooms");
fs.mkdirSync(mockRoomsDir, { recursive: true });

function parseCsvLine(line) {
    const values = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];

        if (char === '"' && inQuotes && next === '"') {
            current += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
            values.push(current);
            current = "";
        } else {
            current += char;
        }
    }

    values.push(current);
    return values;
}

function readCsvSync(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];

    const [headerLine, ...lines] = raw.split(/\r?\n/);
    const headers = parseCsvLine(headerLine).map(h => h.trim());

    return lines
        .filter(line => line.trim())
        .map(line => {
            const values = parseCsvLine(line);
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || "";
            });
            return row;
        });
}

function normalizeKey(value) {
    return String(value || "").trim().toLowerCase();
}

function getMockRoomPath(roomCode) {
    const safeCode = String(roomCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!safeCode) return null;
    return path.join(mockRoomsDir, safeCode, "mock_state.json");
}

function createMockRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 100; attempt++) {
        let code = "";
        for (let i = 0; i < 5; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        if (!fs.existsSync(path.dirname(getMockRoomPath(code)))) return code;
    }
    return String(Date.now()).slice(-6);
}

function getInitialMockState(roomCode) {
    return {
        roomCode,
        started: false,
        claimedTeams: {},
        draftedPicks: [],
        currentPickIndex: 0,
        pickTrades: {},
        timer: {
            defaultSeconds: 120,
            remainingSeconds: 120,
            running: false,
            endAt: null
        },
        announcement: null,
        aiDueAt: null
    };
}

function normalizeMockState(state, roomCode) {
    const initial = getInitialMockState(roomCode);
    return {
        ...initial,
        ...(state || {}),
        roomCode,
        started: Boolean(state?.started),
        claimedTeams: state?.claimedTeams && typeof state.claimedTeams === "object" && !Array.isArray(state.claimedTeams)
            ? state.claimedTeams
            : {},
        draftedPicks: Array.isArray(state?.draftedPicks) ? state.draftedPicks : [],
        currentPickIndex: Number(state?.currentPickIndex || 0),
        pickTrades: state?.pickTrades && typeof state.pickTrades === "object" && !Array.isArray(state.pickTrades)
            ? state.pickTrades
            : {},
        timer: {
            ...initial.timer,
            ...(state?.timer || {})
        },
        announcement: state?.announcement || null,
        aiDueAt: state?.aiDueAt || null
    };
}

function readMockStateRaw(roomCode) {
    const stateFile = getMockRoomPath(roomCode);
    if (!stateFile || !fs.existsSync(stateFile)) return null;
    return normalizeMockState(JSON.parse(fs.readFileSync(stateFile, "utf8")), roomCode);
}

function writeMockState(roomCode, state) {
    const stateFile = getMockRoomPath(roomCode);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(normalizeMockState(state, roomCode), null, 2));
}

function getPlayerPositionType(player) {
    // For mock-draft AI roster logic, use the first listed preferred position
    // as the player's primary role. This prevents flex players from being
    // counted as both skaters and goalies. Example: "Goalie, Defense" => goalie;
    // "Forward, Goalie" => skater. Fall back to position only if pref_pos is blank.
    const preferredText = String(player?.pref_pos || "")
        .split(",")[0]
        .trim()
        .toLowerCase();

    const fallbackText = String(player?.position || "")
        .trim()
        .toLowerCase();

    const text = preferredText || fallbackText;
    const isGoalie = text.includes("goalie") || text === "g";
    const isSkater = !isGoalie;

    return { isSkater, isGoalie };
}

function getDraftedPlayerRole(player, forcedRole, teamCounts) {
    const pos = getPlayerPositionType(player);
    if (forcedRole === "G" && pos.isGoalie) return "G";
    if (forcedRole === "S" && pos.isSkater) return "S";
    if (pos.isGoalie && !pos.isSkater) return "G";
    if (pos.isSkater && !pos.isGoalie) return "S";

    const skatersNeeded = Math.max(0, 6 - Number(teamCounts?.skaters || 0));
    const goaliesNeeded = Math.max(0, 2 - Number(teamCounts?.goalies || 0));
    return goaliesNeeded > skatersNeeded ? "G" : "S";
}

function getTeamRosterCounts(teamId, state, playersByName, teamById) {
    const team = teamById[teamId] || {};
    const captainRole = String(team.captain_role || "S").trim().toUpperCase();
    const counts = {
        skaters: captainRole === "G" ? 0 : 1,
        goalies: captainRole === "G" ? 1 : 0
    };

    (state.draftedPicks || [])
        .filter(pick => pick.team_id === teamId)
        .forEach(pick => {
            if (pick.drafted_role === "G") {
                counts.goalies += 1;
                return;
            }
            if (pick.drafted_role === "S") {
                counts.skaters += 1;
                return;
            }

            const player = playersByName[normalizeKey(pick.player_name)] || {};
            const pos = getPlayerPositionType(player);
            if (pos.isGoalie && !pos.isSkater) counts.goalies += 1;
            else counts.skaters += 1;
        });

    return counts;
}

function weightedRandomPick(candidates) {
    const rankMultipliers = [1, 0.8, 0.5];
    const weights = candidates.map((player, index) => {
        const stock = Math.max(0.001, Number(player.draft_stock || 0));
        return stock * (rankMultipliers[index] || 0.001);
    });

    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = Math.random() * total;

    for (let i = 0; i < candidates.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return candidates[i];
    }

    return candidates[0];
}

function chooseAiPlayer(state, teamId, pickIndex) {
    const players = readCsvSync(path.join(APP_DATA_DIR, "draft_players.csv"));
    const stockRows = readCsvSync(path.join(APP_DATA_DIR, "draft_stock.csv"));
    const teams = readCsvSync(path.join(APP_DATA_DIR, "draft_teams.csv"));
    const draftOrder = readDraftOrderSync();

    const stockByName = {};
    stockRows.forEach(row => {
        stockByName[normalizeKey(row.name)] = row;
    });

    const playersByName = {};
    players.forEach(player => {
        playersByName[normalizeKey(player.name)] = player;
    });

    const teamById = {};
    teams.forEach(team => {
        teamById[team.team_id] = team;
    });

    const draftedNames = new Set((state.draftedPicks || []).map(pick => normalizeKey(pick.player_name)));
    const teamCounts = getTeamRosterCounts(teamId, state, playersByName, teamById);
    const totalTeams = Math.max(1, teams.length);
    const currentRound = Math.floor(pickIndex / totalTeams) + 1;
    const teamPicksMade = (state.draftedPicks || []).filter(pick => pick.team_id === teamId).length;
    const totalDraftRounds = Math.ceil(draftOrder.length / totalTeams);
    const picksRemainingIncludingThis = Math.max(1, totalDraftRounds - teamPicksMade);
    const requiredGoaliesRemaining = Math.max(0, 2 - teamCounts.goalies);
    const requiredSkatersRemaining = Math.max(0, 6 - teamCounts.skaters);

    let forcedRole = null;

    if (teamCounts.goalies === 0 && currentRound >= 3) {
        forcedRole = "G";
    } else if (requiredGoaliesRemaining > 0 && picksRemainingIncludingThis <= requiredGoaliesRemaining) {
        forcedRole = "G";
    } else if (requiredSkatersRemaining > 0 && picksRemainingIncludingThis <= requiredSkatersRemaining) {
        forcedRole = "S";
    }

    let pool = players
        .filter(player => !draftedNames.has(normalizeKey(player.name)))
        .map(player => {
            const stock = stockByName[normalizeKey(player.name)] || {};
            return {
                ...player,
                draft_stock: Number(stock.draft_stock || 0)
            };
        });

    if (forcedRole === "G") {
        pool = pool.filter(player => getPlayerPositionType(player).isGoalie);
    } else if (forcedRole === "S") {
        pool = pool.filter(player => getPlayerPositionType(player).isSkater);
    } else if (teamCounts.goalies >= 1 && currentRound < 6) {
        // Once an AI team already has its starter, avoid drafting a backup goalie
        // until Round 6 or later. Hard roster rules above can still force a goalie
        // when needed to finish with 2 total goalies.
        const skaterPool = pool.filter(player => getPlayerPositionType(player).isSkater);
        if (skaterPool.length > 0) {
            pool = skaterPool;
        }
    }

    if (pool.length === 0) return null;

    const topThree = pool
        .sort((a, b) => Number(b.draft_stock || 0) - Number(a.draft_stock || 0))
        .slice(0, 3);

    const selected = weightedRandomPick(topThree);
    selected.drafted_role = getDraftedPlayerRole(selected, forcedRole, teamCounts);
    return selected;
}

function makeMockPick(state, currentPick, selectedPlayer, teamId, draftedBy = "human") {
    const teams = readCsvSync(path.join(APP_DATA_DIR, "draft_teams.csv"));
    const team = teams.find(row => row.team_id === teamId);
    const originalTeamId = getOriginalTeamId(currentPick);
    const savedPick = {
        pick_number: currentPick.pick_number,
        original_team_id: originalTeamId,
        team_id: teamId,
        player_key: selectedPlayer.player_key || "",
        player_name: selectedPlayer.name || selectedPlayer.player_name || "",
        drafted_by: draftedBy,
        drafted_role: selectedPlayer.drafted_role || ""
    };

    state.draftedPicks.push(savedPick);
    state.currentPickIndex += 1;
    state.announcement = {
        pick_number: savedPick.pick_number,
        original_team_id: savedPick.original_team_id,
        team_id: savedPick.team_id,
        team_name: team?.team_name || savedPick.team_id || "Unknown Team",
        player_name: savedPick.player_name || "",
        drafted_by: draftedBy,
        until: Date.now() + 5000
    };
    state.aiDueAt = null;
    state.timer.running = false;
    state.timer.remainingSeconds = Math.max(0, Number(state.timer.remainingSeconds || 0));
    state.timer.endAt = null;
}

function computeMockState(roomCode, state) {
    const liveState = normalizeMockState(state, roomCode);
    const now = Date.now();
    const timer = liveState.timer;
    const draftOrder = readDraftOrderSync();

    if (liveState.announcement && Number(liveState.announcement.until || 0) <= now) {
        liveState.announcement = null;

        if (liveState.started && liveState.currentPickIndex < draftOrder.length) {
            const nextPick = draftOrder[liveState.currentPickIndex];
            const nextOwnerId = getCurrentPickOwnerId(liveState, nextPick);

            if (liveState.claimedTeams[nextOwnerId]) {
                timer.remainingSeconds = timer.defaultSeconds;
                timer.running = true;
                timer.endAt = now + Number(timer.defaultSeconds || 0) * 1000;
                liveState.aiDueAt = null;
            } else {
                timer.running = false;
                timer.remainingSeconds = timer.defaultSeconds;
                timer.endAt = null;
                liveState.aiDueAt = now + 5000;
            }
        }
    }

    if (liveState.started && !liveState.announcement && liveState.aiDueAt && Number(liveState.aiDueAt) <= now) {
        const currentPick = draftOrder[liveState.currentPickIndex];
        const currentOwnerId = currentPick ? getCurrentPickOwnerId(liveState, currentPick) : "";

        if (currentPick && !liveState.claimedTeams[currentOwnerId]) {
            const aiPlayer = chooseAiPlayer(liveState, currentOwnerId, liveState.currentPickIndex);
            if (aiPlayer) {
                makeMockPick(liveState, currentPick, aiPlayer, currentOwnerId, "AI");
            }
        } else {
            liveState.aiDueAt = null;
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

    if (liveState.currentPickIndex >= draftOrder.length) {
        liveState.started = true;
        liveState.announcement = null;
        liveState.aiDueAt = null;
        timer.running = false;
        timer.endAt = null;
    }

    return liveState;
}

function readMockState(roomCode) {
    const rawState = readMockStateRaw(roomCode);
    if (!rawState) return null;
    const computed = computeMockState(roomCode, rawState);
    writeMockState(roomCode, computed);
    return computed;
}

app.get(["/mock", "/mock/:roomCode"], (req, res) => {
    res.sendFile(path.join(__dirname, "public", "mock.html"));
});

app.post("/api/mock/create-room", (req, res) => {
    try {
        const roomCode = createMockRoomCode();
        const state = getInitialMockState(roomCode);
        writeMockState(roomCode, state);
        res.json({ roomCode, state });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create mock room" });
    }
});

app.get("/api/mock/:roomCode/state", (req, res) => {
    try {
        const state = readMockState(req.params.roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });
        res.json(state);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to read mock room" });
    }
});

app.post("/api/mock/:roomCode/claim-team", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const state = readMockState(roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });
        if (state.started) return res.status(400).json({ error: "Draft has already started" });

        const { team_id, user_id } = req.body || {};
        const teamId = String(team_id || "").trim();
        const userId = String(user_id || "").trim();
        const teams = readCsvSync(path.join(APP_DATA_DIR, "draft_teams.csv"));

        if (!teamId || !userId) return res.status(400).json({ error: "Missing team or user" });
        if (!teams.some(team => team.team_id === teamId)) return res.status(400).json({ error: "Team not found" });

        if (state.claimedTeams[teamId] && state.claimedTeams[teamId] !== userId) {
            return res.status(409).json({ error: "That team is already controlled" });
        }

        state.claimedTeams[teamId] = userId;
        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to claim team" });
    }
});

app.post("/api/mock/:roomCode/start", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const state = readMockState(roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });

        state.started = true;
        state.announcement = null;
        const draftOrder = readDraftOrderSync();
        const currentPick = draftOrder[state.currentPickIndex];
        const currentOwnerId = currentPick ? getCurrentPickOwnerId(state, currentPick) : "";

        if (currentPick && !state.claimedTeams[currentOwnerId]) {
            state.timer.running = false;
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.endAt = null;
            state.aiDueAt = Date.now() + 5000;
        } else {
            state.timer.running = true;
            state.timer.remainingSeconds = state.timer.defaultSeconds;
            state.timer.endAt = Date.now() + Number(state.timer.defaultSeconds || 0) * 1000;
            state.aiDueAt = null;
        }

        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to start mock draft" });
    }
});

app.post("/api/mock/:roomCode/pick", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const state = readMockState(roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });
        if (!state.started) return res.status(400).json({ error: "Draft has not started" });
        if (state.announcement && Number(state.announcement.until || 0) > Date.now()) {
            return res.status(409).json({ error: "Please wait for the current pick announcement to finish." });
        }

        const draftOrder = readDraftOrderSync();
        const currentPick = draftOrder[state.currentPickIndex];
        if (!currentPick) return res.status(400).json({ error: "Draft is already complete" });

        const currentOwnerId = getCurrentPickOwnerId(state, currentPick);
        const { player_name, player_key, user_id } = req.body || {};
        const userId = String(user_id || "").trim();

        if (state.claimedTeams[currentOwnerId] && state.claimedTeams[currentOwnerId] !== userId) {
            return res.status(403).json({ error: "You do not control the team on the clock" });
        }

        const players = readCsvSync(path.join(APP_DATA_DIR, "draft_players.csv"));
        const selectedPlayer = players.find(player =>
            normalizeKey(player.name) === normalizeKey(player_name) ||
            (player_key && String(player.player_key || "") === String(player_key))
        );

        if (!selectedPlayer) return res.status(400).json({ error: "Player not found" });
        if ((state.draftedPicks || []).some(pick => normalizeKey(pick.player_name) === normalizeKey(selectedPlayer.name))) {
            return res.status(400).json({ error: "Player has already been drafted" });
        }

        const playersByName = {};
        players.forEach(player => { playersByName[normalizeKey(player.name)] = player; });
        const teams = readCsvSync(path.join(APP_DATA_DIR, "draft_teams.csv"));
        const teamById = {};
        teams.forEach(team => { teamById[team.team_id] = team; });
        const counts = getTeamRosterCounts(currentOwnerId, state, playersByName, teamById);
        selectedPlayer.drafted_role = getDraftedPlayerRole(selectedPlayer, null, counts);

        makeMockPick(state, currentPick, selectedPlayer, currentOwnerId, "human");
        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to make mock pick" });
    }
});

app.post("/api/mock/:roomCode/reset", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const existing = readMockState(roomCode);
        if (!existing) return res.status(404).json({ error: "Mock room not found" });
        const state = getInitialMockState(roomCode);
        state.claimedTeams = existing.claimedTeams || {};
        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to reset mock draft" });
    }
});

app.post("/api/mock/:roomCode/undo", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const state = readMockState(roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });

        if (state.draftedPicks.length > 0) {
            state.draftedPicks.pop();
            if (state.currentPickIndex > 0) state.currentPickIndex -= 1;
        }

        state.announcement = null;

        const draftOrder = readDraftOrderSync();
        const currentPick = draftOrder[state.currentPickIndex];
        const currentOwnerId = currentPick ? getCurrentPickOwnerId(state, currentPick) : "";

        state.timer.running = false;
        state.timer.remainingSeconds = state.timer.defaultSeconds;
        state.timer.endAt = null;

        // If undo puts an AI-controlled team back on the clock, schedule the AI again.
        // If it puts a human-controlled team back on the clock, restart that pick's timer.
        if (state.started && currentPick) {
            if (state.claimedTeams[currentOwnerId]) {
                state.aiDueAt = null;
                state.timer.running = true;
                state.timer.endAt = Date.now() + Number(state.timer.defaultSeconds || 0) * 1000;
            } else {
                state.aiDueAt = Date.now() + 5000;
            }
        } else {
            state.aiDueAt = null;
        }

        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to undo mock pick" });
    }
});

app.post("/api/mock/:roomCode/timer", (req, res) => {
    try {
        const roomCode = req.params.roomCode.toUpperCase();
        const state = readMockState(roomCode);
        if (!state) return res.status(404).json({ error: "Mock room not found" });
        const { action, seconds } = req.body || {};
        const now = Date.now();

        if (action === "start") {
            state.announcement = null;
            state.aiDueAt = null;
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

        writeMockState(roomCode, state);
        res.json(readMockState(roomCode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update mock timer" });
    }
});

app.listen(PORT, () => {
    console.log(`Draft app running at http://localhost:${PORT}`);
});