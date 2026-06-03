let selectedPlayer = null;
let allPlayers = [];
let allPlayerStats = [];
let allTeams = [];
let draftOrder = [];
let draftedPicks = [];
let currentPickIndex = 0;
let pickTrades = {};

let announcementTimeout = null;
let announcementPickNumber = null;

let currentRole = "viewer";
let currentCaptainTeamId = "";

let timerSeconds = 120;
let timerDefaultSeconds = 120;
let timerInterval = null;
let timerRunning = false;

function renderTimer() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;

    document.querySelector(".timer").textContent =
        `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clearLocalTimerInterval() {
    clearInterval(timerInterval);
    timerInterval = null;
}

function setTimerFromState(timer = {}) {
    timerDefaultSeconds = Number(timer.defaultSeconds || 120);
    timerSeconds = Math.max(0, Number(timer.remainingSeconds ?? timerDefaultSeconds));
    timerRunning = Boolean(timer.running);

    document.querySelector("#startPauseTimerButton").textContent = timerRunning ? "Pause" : "Start";
    renderTimer();

    // The server is the source of truth for the live timer.
    // Clients poll /api/state once per second and render the server-calculated value.
    clearLocalTimerInterval();
}

async function sendTimerAction(action, seconds = null) {
    const response = await fetch("/api/timer", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ action, seconds })
    });

    if (!response.ok) {
        alert("Failed to update timer.");
        return;
    }

    const state = await response.json();
    applyState(state, { forceRender: true });
}

function startTimer() {
    return sendTimerAction("start");
}

function pauseTimer() {
    return sendTimerAction("pause");
}

function resetTimerToDefault() {
    return sendTimerAction("reset");
}

function populateRoleControls() {
    const teamSelect = document.querySelector("#teamSelect");

    teamSelect.innerHTML = "";

    allTeams.forEach(team => {
        const option = document.createElement("option");
        option.value = team.team_id;
        option.textContent = team.team_name;
        teamSelect.appendChild(option);
    });

    if (allTeams.length > 0) {
        currentCaptainTeamId = allTeams[0].team_id;
        teamSelect.value = currentCaptainTeamId;
    }

    updatePermissions();
}

function getRoundAndPick(pickIndex) {
    const teamsCount = allTeams.length;
    const round = Math.floor(pickIndex / teamsCount) + 1;
    const pickInRound = (pickIndex % teamsCount) + 1;
    return { round, pickInRound };
}

function ordinal(n) {
    const suffixes = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function getOriginalTeamId(pick) {
    return pick?.original_team_id || pick?.team_id || "";
}

function getCurrentPickOwnerId(pick) {
    const originalTeamId = getOriginalTeamId(pick);
    const pickNumber = String(pick?.pick_number || "");
    return pickTrades[pickNumber] || originalTeamId;
}

function getTeamById(teamId) {
    return allTeams.find(team => team.team_id === teamId);
}

function getTeamName(teamId) {
    const team = getTeamById(teamId);
    return team ? team.team_name : teamId || "Unknown Team";
}

function formatPickOwnerLabel(pick) {
    if (!pick) return "";

    const originalTeamId = getOriginalTeamId(pick);
    const currentTeamId = getCurrentPickOwnerId(pick);
    const currentTeamName = getTeamName(currentTeamId);

    if (currentTeamId && originalTeamId && currentTeamId !== originalTeamId) {
        return `${currentTeamName} (from ${getTeamName(originalTeamId)})`;
    }

    return currentTeamName;
}

function isPickDrafted(pickNumber) {
    return draftedPicks.some(pick =>
        String(pick.pick_number) === String(pickNumber)
    );
}

function getAvailableTradePicks() {
    return draftOrder.filter(pick =>
        !isPickDrafted(pick.pick_number)
    );
}

function populateTradeControls() {
    const tradePickSelect = document.querySelector("#tradePickSelect");
    const tradeTeamSelect = document.querySelector("#tradeTeamSelect");

    if (!tradePickSelect || !tradeTeamSelect) return;

    const selectedPickNumber = tradePickSelect.value;

    tradePickSelect.innerHTML = "";

    getAvailableTradePicks().forEach(pick => {
        const option = document.createElement("option");
        option.value = pick.pick_number;
        option.textContent = `Pick ${pick.pick_number} — ${formatPickOwnerLabel(pick)}`;
        tradePickSelect.appendChild(option);
    });

    if (selectedPickNumber && [...tradePickSelect.options].some(option => option.value === selectedPickNumber)) {
        tradePickSelect.value = selectedPickNumber;
    }

    const selectedTeamId = tradeTeamSelect.value;

    tradeTeamSelect.innerHTML = "";

    allTeams.forEach(team => {
        const option = document.createElement("option");
        option.value = team.team_id;
        option.textContent = team.team_name;
        tradeTeamSelect.appendChild(option);
    });

    if (selectedTeamId && [...tradeTeamSelect.options].some(option => option.value === selectedTeamId)) {
        tradeTeamSelect.value = selectedTeamId;
    }
}

async function loadData() {
const [playersRes, statsRes, teamsRes, orderRes, stateRes] = await Promise.all([
    fetch("/api/players"),
    fetch("/api/player-stats"),
    fetch("/api/teams"),
    fetch("/api/order"),
    fetch("/api/state")
]);

allPlayers = await playersRes.json();
allPlayerStats = await statsRes.json();
allTeams = await teamsRes.json();
draftOrder = await orderRes.json();

    const state = await stateRes.json();

    renderDraftBoard();
    renderPlayers();
	populateRoleControls();
    applyState(state, { forceRender: true });
}

function applyState(state, options = {}) {
    const oldPickIndex = currentPickIndex;
    const oldDraftedCount = draftedPicks.length;
    const oldPickTradesJson = JSON.stringify(pickTrades || {});
    const oldAnnouncementPickNumber = announcementPickNumber;

    draftedPicks = state.draftedPicks || [];
    currentPickIndex = state.currentPickIndex || 0;
    pickTrades = state.pickTrades || {};

    setTimerFromState(state.timer || {});

    const announcement = state.announcement;

    if (announcement && Number(announcement.until || 0) > Date.now()) {
        renderPickAnnouncement(announcement);
    } else {
        announcementPickNumber = null;
        document.querySelector(".current-pick-card").classList.remove("announcement-highlight");
        renderCurrentPick();
    }

    const pickTradesChanged = oldPickTradesJson !== JSON.stringify(pickTrades || {});
    const announcementChanged = String(oldAnnouncementPickNumber || "") !== String(announcementPickNumber || "");

    if (options.forceRender || oldPickIndex !== currentPickIndex || oldDraftedCount !== draftedPicks.length || pickTradesChanged || announcementChanged) {
        renderDraftBoard();
        renderPlayers();
        populateTradeControls();
    }

    updatePermissions();
}

async function pollDraftState() {
    try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) return;

        const state = await response.json();
        applyState(state);
    } catch (err) {
        console.warn("Failed to poll draft state", err);
    }
}

function updatePermissions() {
    const draftButton = document.querySelector("#draftButton");
    const resetButton = document.querySelector("#resetDraftButton");
    const undoButton = document.querySelector("#undoDraftButton");
    const teamSelect = document.querySelector("#teamSelect");
    const startPauseTimerButton = document.querySelector("#startPauseTimerButton");
    const resetTimerButton = document.querySelector("#resetTimerButton");
	const setTimerLengthButton = document.querySelector("#setTimerLengthButton");
	const exportDraftButton = document.querySelector("#exportDraftButton");
    const tradePickControls = document.querySelector("#tradePickControls");
    const exportStatus = document.querySelector("#exportStatus");

    const currentPick = draftOrder[currentPickIndex];
	const draftComplete = !currentPick;
    const announcementActive = Boolean(announcementPickNumber);

    const isCommish = currentRole === "commish";
    const currentOwnerId = currentPick ? getCurrentPickOwnerId(currentPick) : "";
    const isCaptainOnClock =
        currentRole === "captain" &&
        currentPick &&
        currentOwnerId === currentCaptainTeamId;

    teamSelect.hidden = currentRole !== "captain";

    resetButton.hidden = !isCommish;
    undoButton.hidden = !isCommish;
    startPauseTimerButton.hidden = !isCommish;
    resetTimerButton.hidden = !isCommish;
	setTimerLengthButton.hidden = !isCommish;
	exportDraftButton.hidden = !isCommish;
    if (tradePickControls) tradePickControls.hidden = !isCommish;

    if (draftComplete) {
    draftButton.hidden = true;
    draftButton.disabled = true;

    if (isCommish) {
        exportStatus.hidden = false;
        exportStatus.textContent = "Draft complete — results have been exported.";
    }

    return;
}

exportStatus.hidden = true;
exportStatus.textContent = "";

if (!selectedPlayer || announcementActive) {
        draftButton.disabled = true;
        draftButton.hidden = currentRole === "viewer";
        return;
    }

    draftButton.hidden = currentRole === "viewer";
    draftButton.disabled = !(isCommish || isCaptainOnClock);
}

function renderDraftBoard() {
    const draftBoard = document.querySelector("#draftBoard");

    const playerByKey = {};
    allPlayers.forEach(player => {
        if (player.player_key) {
            playerByKey[player.player_key] = player;
        }
    });

    const picksByTeam = {};

    draftOrder.forEach(pick => {
        const teamId = getCurrentPickOwnerId(pick);
        if (!picksByTeam[teamId]) picksByTeam[teamId] = [];
        picksByTeam[teamId].push(pick);
    });

    const maxRounds = Math.max(1, ...Object.values(picksByTeam).map(picks => picks.length));

    let html = `
        <table class="draft-board-table">
            <thead>
                <tr>
                    <th>Team</th>
                    <th>Captain</th>
    `;

    for (let round = 1; round <= maxRounds; round++) {
        html += `<th>${round}</th>`;
    }

    html += `
                </tr>
            </thead>
            <tbody>
    `;

allTeams.forEach(team => {
    const captain = playerByKey[team.captain_player_key];
    const captainName = captain ? captain.name : team.captain_player_key || "";
    const teamPicks = picksByTeam[team.team_id] || [];

    const currentPick = draftOrder[currentPickIndex];
    const currentPickOwnerId = currentPick ? getCurrentPickOwnerId(currentPick) : "";

    const teamHasCurrentPick =
        announcementPickNumber === null &&
        currentPick &&
        currentPickOwnerId === team.team_id;

const announcementPick = draftOrder.find(pick =>
    String(pick.pick_number) === String(announcementPickNumber)
);

const teamHasAnnouncementPick =
    announcementPickNumber !== null &&
    announcementPick &&
    getCurrentPickOwnerId(announcementPick) === team.team_id;

const rowClass = teamHasCurrentPick || teamHasAnnouncementPick
    ? "current-pick-row"
    : "";

html += `
    <tr class="${rowClass}">
        <td class="team-cell">${team.team_name}</td>
        <td class="captain-cell">${captainName}</td>
`;

for (let i = 0; i < maxRounds; i++) {
    const teamPick = teamPicks[i];

    const draftedPick = draftedPicks.find(pick =>
        String(pick.pick_number) === String(teamPick?.pick_number)
    );

const isAnnouncementPick =
    announcementPickNumber !== null &&
    String(teamPick?.pick_number) === String(announcementPickNumber);

const isCurrentPick =
    announcementPickNumber === null &&
    currentPickIndex < draftOrder.length &&
    String(teamPick?.pick_number) === String(draftOrder[currentPickIndex]?.pick_number);

const cellClass = isAnnouncementPick || isCurrentPick ? "current-pick-cell" : "";
const originalTeamId = getOriginalTeamId(teamPick);
const currentOwnerId = teamPick ? getCurrentPickOwnerId(teamPick) : "";
const isTraded = teamPick && originalTeamId && currentOwnerId && originalTeamId !== currentOwnerId;

    html += `
<td class="${cellClass}">
    ${
        draftedPick
            ? `<span class="drafted-player-link"
                data-player="${draftedPick.player_name}">
                ${draftedPick.player_name}
               </span>`
            : isTraded
                ? `<span class="traded-pick-note">from ${getTeamName(originalTeamId)}</span>`
                : ""
    }
</td>`;
}

        html += `</tr>`;
    });

    html += `
            </tbody>
        </table>
    `;

    draftBoard.innerHTML = html;
	draftBoard.querySelectorAll(".drafted-player-link").forEach(link => {
    link.addEventListener("click", () => {
        const playerName = link.dataset.player;

        const player = allPlayers.find(p =>
            p.name === playerName
        );

        if (player) {
            selectPlayer(player);
        }
    });
});
}

function renderCurrentPick() {
    const currentPick = draftOrder[currentPickIndex];

    const currentPickCard = document.querySelector(".current-pick-card");
    currentPickCard.classList.remove("announcement-highlight");

    if (!currentPick) {
    document.querySelector("#currentTeam").textContent = "Draft Complete";
    document.querySelector("#currentPick").textContent = "";

    clearLocalTimerInterval();
    timerRunning = false;
    document.querySelector("#startPauseTimerButton").textContent = "Start";

    return;
}

    const { round, pickInRound } = getRoundAndPick(currentPickIndex);

    document.querySelector("#currentTeam").textContent = formatPickOwnerLabel(currentPick);

    document.querySelector("#currentPick").textContent =
        `Round ${round}, ${ordinal(Number(currentPick.pick_number))} overall pick`;
}

function renderPickAnnouncement(announcement) {
    const currentPickCard = document.querySelector(".current-pick-card");

    announcementPickNumber = announcement.pick_number;

    document.querySelector("#currentTeam").textContent = announcement.team_name || "Unknown Team";
    document.querySelector("#currentPick").textContent =
        `Selects ${announcement.player_name} with the ${ordinal(Number(announcement.pick_number))} overall pick.`;

    currentPickCard.classList.add("announcement-highlight");
}

function showPickAnnouncement() {
    // Announcements are now shared through /api/state so every browser sees them.
    pollDraftState();
}

function renderPlayers() {
    const players = getAvailablePlayers();

    const skatersList = document.querySelector("#skatersList");
    const goaliesList = document.querySelector("#goaliesList");
    const flexList = document.querySelector("#flexList");

    skatersList.innerHTML = "";
    goaliesList.innerHTML = "";
    flexList.innerHTML = "";

    players
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(player => {
            const position = (player.position || "").toLowerCase();
            const isFlex = position.includes("skater") && position.includes("goalie");

            if (isFlex) {
                addPlayerItem(flexList, player, true);
            } else if (position.includes("goalie")) {
                addPlayerItem(goaliesList, player, false);
            } else {
                addPlayerItem(skatersList, player, false);
            }
        });
}

function getAvailablePlayers() {
    return allPlayers.filter(player => {
        return !draftedPicks.some(pick => pick.player_name === player.name);
    });
}

function addPlayerItem(listElement, player, isFlex) {
    const item = document.createElement("div");
    item.className = "player-item";
    item.textContent = player.name;

    item.addEventListener("click", () => {
        selectPlayer(player);
    });

    listElement.appendChild(item);
}

function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
}

function findPlayerStats(player) {
    const playerKey = normalizeText(player.player_key);
    const playerName = normalizeText(player.name);

    if (playerKey) {
        const keyMatch = allPlayerStats.find(stats =>
            normalizeText(stats.player_key) === playerKey
        );

        if (keyMatch) return keyMatch;
    }

    return allPlayerStats.find(stats =>
        normalizeText(stats.name) === playerName
    );
}

function statValue(value) {
    return String(value || "").trim() || "-";
}

function selectPlayer(player) {
    selectedPlayer = player;

    const selectedDiv = document.querySelector("#selectedPlayer");
    const stats = findPlayerStats(player);

    let statsHtml = "";

    if (stats) {
        statsHtml = `
            <div class="player-stats-grid">
                <div>
                    <h3>Skater Stats</h3>
                    <table class="player-stats-table">
                        <thead>
                            <tr>
                                <th>Season</th>
                                <th>GP</th>
                                <th>G</th>
                                <th>A</th>
                                <th>PTS</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td>S1 Regular Season</td><td>${statValue(stats.s1_reg_sk_gp)}</td><td>${statValue(stats.s1_reg_g)}</td><td>${statValue(stats.s1_reg_a)}</td><td>${statValue(stats.s1_reg_pts)}</td></tr>
                            <tr><td>S1 Playoffs</td><td>${statValue(stats.s1_po_sk_gp)}</td><td>${statValue(stats.s1_po_g)}</td><td>${statValue(stats.s1_po_a)}</td><td>${statValue(stats.s1_po_pts)}</td></tr>
                            <tr><td>S2 Regular Season</td><td>${statValue(stats.s2_reg_sk_gp)}</td><td>${statValue(stats.s2_reg_g)}</td><td>${statValue(stats.s2_reg_a)}</td><td>${statValue(stats.s2_reg_pts)}</td></tr>
                            <tr><td>S2 Playoffs</td><td>${statValue(stats.s2_po_sk_gp)}</td><td>${statValue(stats.s2_po_g)}</td><td>${statValue(stats.s2_po_a)}</td><td>${statValue(stats.s2_po_pts)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <div>
                    <h3>Goalie Stats</h3>
                    <table class="player-stats-table">
                        <thead>
                            <tr>
                                <th>Season</th>
                                <th>GP</th>
                                <th>SV</th>
                                <th>GAA</th>
                                <th>SV%</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td>S1 Regular Season</td><td>${statValue(stats.s1_reg_g_gp)}</td><td>${statValue(stats.s1_reg_sv)}</td><td>${statValue(stats.s1_reg_gaa)}</td><td>${statValue(stats.s1_reg_sv_pct)}</td></tr>
                            <tr><td>S1 Playoffs</td><td>${statValue(stats.s1_po_g_gp)}</td><td>${statValue(stats.s1_po_sv)}</td><td>${statValue(stats.s1_po_gaa)}</td><td>${statValue(stats.s1_po_sv_pct)}</td></tr>
                            <tr><td>S2 Regular Season</td><td>${statValue(stats.s2_reg_g_gp)}</td><td>${statValue(stats.s2_reg_sv)}</td><td>${statValue(stats.s2_reg_gaa)}</td><td>${statValue(stats.s2_reg_sv_pct)}</td></tr>
                            <tr><td>S2 Playoffs</td><td>${statValue(stats.s2_po_g_gp)}</td><td>${statValue(stats.s2_po_sv)}</td><td>${statValue(stats.s2_po_gaa)}</td><td>${statValue(stats.s2_po_sv_pct)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    } else {
        statsHtml = `<p><em>No WCPL stats found.</em></p>`;
    }

    selectedDiv.innerHTML = `
        <div class="selected-player-summary">
            <p><strong>Name:</strong> ${player.name}</p>
            <p><strong>Position:</strong> ${player.position}</p>
            <p><strong>Availability:</strong> ${player.avail || "N/A"}</p>
            <p><strong>Preferred Position:</strong> ${player.pref_pos || "N/A"}</p>
        </div>

        ${statsHtml}
    `;

    updatePermissions();
}

document.querySelector("#draftButton").addEventListener("click", async () => {
    if (!selectedPlayer) return;

    if (announcementPickNumber) {
        alert("Please wait for the current pick announcement to finish.");
        return;
    }

    const currentPick = draftOrder[currentPickIndex];
    if (!currentPick) return;

    const currentOwnerId = getCurrentPickOwnerId(currentPick);
    const pick = {
        pick_number: currentPick.pick_number,
        team_id: currentOwnerId,
        player_key: selectedPlayer.player_key,
        player_name: selectedPlayer.name
    };
	
    const announcementTeamName = formatPickOwnerLabel(currentPick);
const confirmed = confirm(
    `Draft ${selectedPlayer.name} to ${announcementTeamName} with the ${ordinal(Number(currentPick.pick_number))} overall pick?`
);

if (!confirmed) return;

    const response = await fetch("/api/pick", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ pick })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Failed to make pick.");
        return;
    }

    const state = await response.json();

    selectedPlayer = null;

    document.querySelector("#selectedPlayer").textContent =
        "Click a player above to view details.";

    document.querySelector("#draftButton").disabled = true;

    applyState(state, { forceRender: true });
});

document.querySelector("#resetDraftButton").addEventListener("click", async () => {
    const confirmed = confirm("Reset the entire draft? This will clear all picks.");

    if (!confirmed) return;

    const response = await fetch("/api/reset", {
        method: "POST"
    });

    const state = await response.json();

    selectedPlayer = null;

    document.querySelector("#selectedPlayer").textContent =
        "Click a player above to view details.";

    document.querySelector("#draftButton").disabled = true;

    applyState(state, { forceRender: true });
});

document.querySelector("#undoDraftButton").addEventListener("click", async () => {

    const confirmed = confirm("Undo the most recent draft pick?");

    if (!confirmed) return;

    const response = await fetch("/api/undo", {
        method: "POST"
    });

    const state = await response.json();

    selectedPlayer = null;

    document.querySelector("#selectedPlayer").textContent =
        "Click a player above to view details.";

    document.querySelector("#draftButton").disabled = true;

    applyState(state, { forceRender: true });
});

document.querySelector("#playerSearch").addEventListener("input", () => {
    const query = document.querySelector("#playerSearch").value.trim().toLowerCase();
    const resultsDiv = document.querySelector("#searchResults");

resultsDiv.innerHTML = "";
resultsDiv.classList.remove("has-results");

if (!query) return;

    const matches = getAvailablePlayers()
        .filter(player => player.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 10);

    matches.forEach(player => {
        const item = document.createElement("div");
        item.className = "search-result-item";
        item.textContent = `${player.name} (${player.position})`;

item.addEventListener("click", () => {
    selectPlayer(player);

    document.querySelector("#playerSearch").value = "";

    resultsDiv.innerHTML = "";
    resultsDiv.classList.remove("has-results");
});
        resultsDiv.appendChild(item);
    });
	
	if (matches.length > 0) {
    resultsDiv.classList.add("has-results");
}
});

document.querySelector("#roleSelect").addEventListener("change", () => {
    currentRole = document.querySelector("#roleSelect").value;
    updatePermissions();
});

document.querySelector("#teamSelect").addEventListener("change", () => {
    currentCaptainTeamId = document.querySelector("#teamSelect").value;
    updatePermissions();
});

document.querySelector("#startPauseTimerButton").addEventListener("click", () => {
    if (timerRunning) {
        pauseTimer();
    } else {
        startTimer();
    }
});

document.querySelector("#resetTimerButton").addEventListener("click", () => {
    pauseTimer();
    resetTimerToDefault();
});

document.querySelector("#setTimerLengthButton").addEventListener("click", () => {
    const input = prompt("Enter timer length in minutes:", timerDefaultSeconds / 60);

    if (input === null) return;

    const minutes = Number(input);

    if (!Number.isFinite(minutes) || minutes <= 0) {
        alert("Please enter a valid number of minutes.");
        return;
    }

    sendTimerAction("set-length", Math.round(minutes * 60));
});

document.querySelector("#loginButton").addEventListener("click", async () => {
    const password = prompt("Enter password:");

    if (!password) return;

    const response = await fetch("/api/login", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
    });

    if (!response.ok) {
        alert("Invalid password.");
        return;
    }

    const user = await response.json();

    currentRole = user.role;
    currentCaptainTeamId = user.team_id || "";

    document.querySelector("#loginStatus").textContent =
        user.role === "commish"
            ? "Commissioner"
            : `${user.display_name} Captain`;

    document.querySelector("#loginButton").hidden = true;
    document.querySelector("#logoutButton").hidden = false;

    updatePermissions();
});

document.querySelector("#logoutButton").addEventListener("click", () => {
    currentRole = "viewer";
    currentCaptainTeamId = "";

    document.querySelector("#loginStatus").textContent = "Viewer";
    document.querySelector("#loginButton").hidden = false;
    document.querySelector("#logoutButton").hidden = true;

    updatePermissions();
});


document.querySelector("#tradePickButton").addEventListener("click", async () => {
    const pickNumber = document.querySelector("#tradePickSelect").value;
    const newTeamId = document.querySelector("#tradeTeamSelect").value;

    if (!pickNumber || !newTeamId) {
        alert("Choose a pick and a new owner.");
        return;
    }

    const pick = draftOrder.find(row =>
        String(row.pick_number) === String(pickNumber)
    );

    if (!pick) {
        alert("Could not find that draft pick.");
        return;
    }

    const currentLabel = formatPickOwnerLabel(pick);
    const newTeamName = getTeamName(newTeamId);

    const confirmed = confirm(
        `Trade Pick ${pickNumber} from ${currentLabel} to ${newTeamName}?`
    );

    if (!confirmed) return;

    const response = await fetch("/api/trade-pick", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            pick_number: pickNumber,
            new_team_id: newTeamId
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Failed to trade draft pick.");
        return;
    }

    const state = await response.json();
    applyState(state, { forceRender: true });
});


document.querySelector("#exportDraftButton").addEventListener("click", async () => {
    const response = await fetch("/api/export-results", {
        method: "POST"
    });

    if (!response.ok) {
        alert("Failed to export draft results.");
        return;
    }

    const result = await response.json();

    const exportStatus = document.querySelector("#exportStatus");
    exportStatus.hidden = false;
    exportStatus.textContent = result.message || "Draft results exported.";
});

loadData();
setInterval(pollDraftState, 1000);