let selectedPlayer = null;
let allPlayers = [];
let allPlayerStats = [];
let allTeams = [];
let draftOrder = [];
let draftedPicks = [];
let currentPickIndex = 0;
let pickTrades = {};
let claimedTeams = {};
let started = false;
let announcementPickNumber = null;
let aiDueAt = null;
let timerSeconds = 120;
let timerDefaultSeconds = 120;
let timerRunning = false;
let timerInterval = null;

const userId = getOrCreateUserId();
const roomCode = getRoomCodeFromUrl();

function getOrCreateUserId() {
    let id = localStorage.getItem("wcpl_mock_user_id");
    if (!id) {
        id = `user_${Math.random().toString(36).slice(2)}_${Date.now()}`;
        localStorage.setItem("wcpl_mock_user_id", id);
    }
    return id;
}

function getRoomCodeFromUrl() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    return parts[0] === "mock" && parts[1] ? parts[1].toUpperCase() : "";
}

function ordinal(n) {
    const suffixes = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeColor(value, fallback) {
    const text = String(value || "").trim();
    return /^#[0-9A-Fa-f]{6}$/.test(text) ? text : fallback;
}

function getTeamLogoPath(teamId) {
    return teamId ? `/images/team_logos/${teamId}.png` : "";
}

function getTeamBgColor(team) {
    return normalizeColor(team?.bg_color, "#ffffff");
}

function getTeamTextColor(team) {
    return normalizeColor(team?.text_color, "#000000");
}

function renderTeamLogo(teamId, className = "team-logo") {
    if (!teamId) return "";
    return `<img src="${getTeamLogoPath(teamId)}" alt="" class="${className}" onerror="this.style.display='none'">`;
}

function renderTeamNameWithLogo(team) {
    if (!team) return "Unknown Team";
    return `<span class="team-name-with-logo">${renderTeamLogo(team.team_id, "team-logo team-logo-board")}<span>${escapeHtml(team.team_name)}</span></span>`;
}

function renderCurrentTeamHeading(team, labelText) {
    if (!team) return escapeHtml(labelText || "Unknown Team");
    return `<span class="current-team-heading"><span class="current-team-logo-wrap">${renderTeamLogo(team.team_id, "team-logo current-team-logo")}</span><span class="current-team-name">${escapeHtml(labelText || team.team_name)}</span></span>`;
}

function setCurrentPickTeamStyle(team) {
    const card = document.querySelector(".current-pick-card");
    if (!card) return;
    if (!team) {
        card.style.backgroundColor = "";
        card.style.color = "";
        return;
    }
    card.style.backgroundColor = getTeamBgColor(team);
    card.style.color = getTeamTextColor(team);
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
    return getTeamById(teamId)?.team_name || teamId || "Unknown Team";
}

function formatPickOwnerLabel(pick) {
    const originalTeamId = getOriginalTeamId(pick);
    const currentTeamId = getCurrentPickOwnerId(pick);
    const currentTeamName = getTeamName(currentTeamId);
    if (currentTeamId && originalTeamId && currentTeamId !== originalTeamId) {
        return `${currentTeamName} (from ${getTeamName(originalTeamId)})`;
    }
    return currentTeamName;
}

function getRoundAndPick(pickIndex) {
    const teamsCount = Math.max(1, allTeams.length);
    return {
        round: Math.floor(pickIndex / teamsCount) + 1,
        pickInRound: (pickIndex % teamsCount) + 1
    };
}

function renderTimer() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    document.querySelector(".timer").textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
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
    clearLocalTimerInterval();
}

async function loadSharedData() {
    const [playersRes, statsRes, teamsRes, orderRes] = await Promise.all([
        fetch("/api/players"),
        fetch("/api/player-stats"),
        fetch("/api/teams"),
        fetch("/api/order")
    ]);
    allPlayers = await playersRes.json();
    allPlayerStats = await statsRes.json();
    allTeams = await teamsRes.json();
    draftOrder = await orderRes.json();
}

async function loadRoom() {
    if (!roomCode) {
        document.querySelector("#mockLanding").hidden = false;
        return;
    }

    document.querySelector("#mockRoom").hidden = false;
    document.querySelector("#roomCodeLabel").textContent = `— ${roomCode}`;
    await loadSharedData();
    const response = await fetch(`/api/mock/${roomCode}/state`, { cache: "no-store" });
    if (!response.ok) {
        alert("Mock room not found. Create a new room.");
        window.location.href = "/mock";
        return;
    }
    applyState(await response.json(), { forceRender: true });
}

function applyState(state, options = {}) {
    const oldPickIndex = currentPickIndex;
    const oldDraftedCount = draftedPicks.length;
    const oldAnnouncementPickNumber = announcementPickNumber;
    const oldClaimsJson = JSON.stringify(claimedTeams || {});

    draftedPicks = state.draftedPicks || [];
    currentPickIndex = Number(state.currentPickIndex || 0);
    pickTrades = state.pickTrades || {};
    claimedTeams = state.claimedTeams || {};
    started = Boolean(state.started);
    aiDueAt = state.aiDueAt || null;

    setTimerFromState(state.timer || {});

    const announcement = state.announcement;
    if (announcement && Number(announcement.until || 0) > Date.now()) {
        renderPickAnnouncement(announcement);
    } else {
        announcementPickNumber = null;
        renderCurrentPick();
    }

    const claimsChanged = oldClaimsJson !== JSON.stringify(claimedTeams || {});
    const announcementChanged = String(oldAnnouncementPickNumber || "") !== String(announcementPickNumber || "");

    if (options.forceRender || oldPickIndex !== currentPickIndex || oldDraftedCount !== draftedPicks.length || claimsChanged || announcementChanged) {
        renderDraftBoard();
        renderPlayers();
    }
    updatePermissions();
}

async function pollDraftState() {
    if (!roomCode) return;
    try {
        const response = await fetch(`/api/mock/${roomCode}/state`, { cache: "no-store" });
        if (!response.ok) return;
        applyState(await response.json());
    } catch (err) {
        console.warn("Failed to poll mock state", err);
    }
}

function getControlledTeamIds() {
    return Object.keys(claimedTeams).filter(teamId => claimedTeams[teamId] === userId);
}

function getControlledTeamId() {
    return getControlledTeamIds()[0] || "";
}

function renderDraftBoard() {
    const draftBoard = document.querySelector("#draftBoard");
    const playerByKey = {};
    allPlayers.forEach(player => {
        if (player.player_key) playerByKey[player.player_key] = player;
    });

    const picksByTeam = {};
    draftOrder.forEach(pick => {
        const teamId = getCurrentPickOwnerId(pick);
        if (!picksByTeam[teamId]) picksByTeam[teamId] = [];
        picksByTeam[teamId].push(pick);
    });

    const maxRounds = Math.max(1, ...Object.values(picksByTeam).map(picks => picks.length));

    let html = `<table class="draft-board-table"><thead><tr><th>Team</th><th>Captain</th>`;
    for (let round = 1; round <= maxRounds; round++) html += `<th>${round}</th>`;
    html += `</tr></thead><tbody>`;

    allTeams.forEach(team => {
        const captain = playerByKey[team.captain_player_key];
        const captainName = captain ? captain.name : team.captain_player_key || "";
        const teamPicks = picksByTeam[team.team_id] || [];
        const currentPick = draftOrder[currentPickIndex];
        const currentPickOwnerId = currentPick ? getCurrentPickOwnerId(currentPick) : "";
        const teamHasCurrentPick = announcementPickNumber === null && currentPick && currentPickOwnerId === team.team_id;
        const announcementPick = draftOrder.find(pick => String(pick.pick_number) === String(announcementPickNumber));
        const teamHasAnnouncementPick = announcementPickNumber !== null && announcementPick && getCurrentPickOwnerId(announcementPick) === team.team_id;
        const rowClass = teamHasCurrentPick || teamHasAnnouncementPick ? "current-pick-row" : "";
        const teamCellStyle = `background-color: ${getTeamBgColor(team)}; color: ${getTeamTextColor(team)};`;
        const claimedBy = claimedTeams[team.team_id];
        const controlledByMe = claimedBy === userId;
        const claimLabel = controlledByMe ? "You Control" : claimedBy ? "Controlled" : "Control Team";
        const claimButton = !started
            ? `<button class="control-team-button" data-team="${team.team_id}" ${claimedBy && !controlledByMe ? "disabled" : ""}>${claimLabel}</button>`
            : `<span class="control-team-status">${controlledByMe ? "You" : claimedBy ? "Human" : "AI"}</span>`;

        html += `<tr class="${rowClass}"><td class="team-cell" style="${teamCellStyle}">${renderTeamNameWithLogo(team)}${claimButton}</td><td class="captain-cell">${escapeHtml(captainName)}</td>`;

        for (let i = 0; i < maxRounds; i++) {
            const teamPick = teamPicks[i];
            const draftedPick = draftedPicks.find(pick => String(pick.pick_number) === String(teamPick?.pick_number));
            const isAnnouncementPick = announcementPickNumber !== null && String(teamPick?.pick_number) === String(announcementPickNumber);
            const isCurrentPick = announcementPickNumber === null && currentPickIndex < draftOrder.length && String(teamPick?.pick_number) === String(draftOrder[currentPickIndex]?.pick_number);
            const cellClass = isAnnouncementPick || isCurrentPick ? "current-pick-cell" : "";
            html += `<td class="${cellClass}">${draftedPick ? `<span class="drafted-player-link" data-player="${escapeHtml(draftedPick.player_name)}">${escapeHtml(draftedPick.player_name)}${draftedPick.drafted_by === "AI" ? " 🤖" : ""}</span>` : ""}</td>`;
        }

        html += `</tr>`;
    });

    html += `</tbody></table>`;
    draftBoard.innerHTML = html;

    draftBoard.querySelectorAll(".drafted-player-link").forEach(link => {
        link.addEventListener("click", () => {
            const player = allPlayers.find(p => p.name === link.dataset.player);
            if (player) selectPlayer(player);
        });
    });

    draftBoard.querySelectorAll(".control-team-button").forEach(button => {
        button.addEventListener("click", () => claimTeam(button.dataset.team));
    });
}

function renderCurrentPick() {
    const currentPick = draftOrder[currentPickIndex];
    const status = document.querySelector("#mockStatus");

    if (!currentPick) {
        setCurrentPickTeamStyle(null);
        document.querySelector("#currentTeam").textContent = "Draft Complete";
        document.querySelector("#currentPick").textContent = "";
        status.textContent = "";
        return;
    }

    const { round } = getRoundAndPick(currentPickIndex);
    const ownerId = getCurrentPickOwnerId(currentPick);
    const team = getTeamById(ownerId);
    const ownerLabel = formatPickOwnerLabel(currentPick);
    setCurrentPickTeamStyle(team);
    document.querySelector("#currentTeam").innerHTML = renderCurrentTeamHeading(team, ownerLabel);
    document.querySelector("#currentPick").textContent = `Round ${round}, ${ordinal(Number(currentPick.pick_number))} overall pick`;

    if (!started) status.textContent = "Claim teams, then start the draft.";
    else if (!claimedTeams[ownerId]) status.textContent = aiDueAt ? "AI is thinking..." : "AI controlled team.";
    else if (claimedTeams[ownerId] === userId) status.textContent = "Your pick.";
    else status.textContent = "Waiting for another user.";
}

function renderPickAnnouncement(announcement) {
    announcementPickNumber = announcement.pick_number;
    const team = getTeamById(announcement.team_id);
    setCurrentPickTeamStyle(team);
    document.querySelector("#currentTeam").innerHTML = renderCurrentTeamHeading(team, announcement.team_name || "Unknown Team");
    document.querySelector("#currentPick").textContent = `Selects ${announcement.player_name} with the ${ordinal(Number(announcement.pick_number))} overall pick.`;
    document.querySelector("#mockStatus").textContent = announcement.drafted_by === "AI" ? "AI pick" : "Human pick";
}

function renderPlayers() {
    const players = getAvailablePlayers();
    const skatersList = document.querySelector("#skatersList");
    const goaliesList = document.querySelector("#goaliesList");
    const flexList = document.querySelector("#flexList");
    skatersList.innerHTML = "";
    goaliesList.innerHTML = "";
    flexList.innerHTML = "";

    players.sort((a, b) => a.name.localeCompare(b.name)).forEach(player => {
        const position = (player.position || "").toLowerCase();
        const isFlex = position.includes("skater") && position.includes("goalie");
        if (isFlex) addPlayerItem(flexList, player);
        else if (position.includes("goalie")) addPlayerItem(goaliesList, player);
        else addPlayerItem(skatersList, player);
    });
}

function getAvailablePlayers() {
    return allPlayers.filter(player => !draftedPicks.some(pick => pick.player_name === player.name));
}

function addPlayerItem(listElement, player) {
    const item = document.createElement("div");
    item.className = "player-item";
    item.textContent = player.name;
    item.addEventListener("click", () => selectPlayer(player));
    listElement.appendChild(item);
}

function findPlayerStats(player) {
    const playerKey = normalizeText(player.player_key);
    const playerName = normalizeText(player.name);
    if (playerKey) {
        const keyMatch = allPlayerStats.find(stats => normalizeText(stats.player_key) === playerKey);
        if (keyMatch) return keyMatch;
    }
    return allPlayerStats.find(stats => normalizeText(stats.name) === playerName);
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
        statsHtml = `<div class="player-stats-grid"><div><h3>Skater Stats</h3><table class="player-stats-table"><thead><tr><th>Season</th><th>GP</th><th>G</th><th>A</th><th>PTS</th></tr></thead><tbody><tr><td>S1 Regular Season</td><td>${statValue(stats.s1_reg_sk_gp)}</td><td>${statValue(stats.s1_reg_g)}</td><td>${statValue(stats.s1_reg_a)}</td><td>${statValue(stats.s1_reg_pts)}</td></tr><tr><td>S1 Playoffs</td><td>${statValue(stats.s1_po_sk_gp)}</td><td>${statValue(stats.s1_po_g)}</td><td>${statValue(stats.s1_po_a)}</td><td>${statValue(stats.s1_po_pts)}</td></tr><tr><td>S2 Regular Season</td><td>${statValue(stats.s2_reg_sk_gp)}</td><td>${statValue(stats.s2_reg_g)}</td><td>${statValue(stats.s2_reg_a)}</td><td>${statValue(stats.s2_reg_pts)}</td></tr><tr><td>S2 Playoffs</td><td>${statValue(stats.s2_po_sk_gp)}</td><td>${statValue(stats.s2_po_g)}</td><td>${statValue(stats.s2_po_a)}</td><td>${statValue(stats.s2_po_pts)}</td></tr></tbody></table></div><div><h3>Goalie Stats</h3><table class="player-stats-table"><thead><tr><th>Season</th><th>GP</th><th>SV</th><th>GAA</th><th>SV%</th></tr></thead><tbody><tr><td>S1 Regular Season</td><td>${statValue(stats.s1_reg_g_gp)}</td><td>${statValue(stats.s1_reg_sv)}</td><td>${statValue(stats.s1_reg_gaa)}</td><td>${statValue(stats.s1_reg_sv_pct)}</td></tr><tr><td>S1 Playoffs</td><td>${statValue(stats.s1_po_g_gp)}</td><td>${statValue(stats.s1_po_sv)}</td><td>${statValue(stats.s1_po_gaa)}</td><td>${statValue(stats.s1_po_sv_pct)}</td></tr><tr><td>S2 Regular Season</td><td>${statValue(stats.s2_reg_g_gp)}</td><td>${statValue(stats.s2_reg_sv)}</td><td>${statValue(stats.s2_reg_gaa)}</td><td>${statValue(stats.s2_reg_sv_pct)}</td></tr><tr><td>S2 Playoffs</td><td>${statValue(stats.s2_po_g_gp)}</td><td>${statValue(stats.s2_po_sv)}</td><td>${statValue(stats.s2_po_gaa)}</td><td>${statValue(stats.s2_po_sv_pct)}</td></tr></tbody></table></div></div>`;
    } else {
        statsHtml = `<p><em>No WCPL stats found.</em></p>`;
    }

    selectedDiv.innerHTML = `<div class="selected-player-summary"><p><strong>Name:</strong> ${escapeHtml(player.name)}</p><p><strong>Position:</strong> ${escapeHtml(player.position)}</p><p><strong>Availability:</strong> ${escapeHtml(player.avail || "N/A")}</p><p><strong>Preferred Position:</strong> ${escapeHtml(player.pref_pos || "N/A")}</p></div>${statsHtml}`;
    updatePermissions();
}

function updatePermissions() {
    const draftButton = document.querySelector("#draftButton");
    const startButton = document.querySelector("#startMockDraftButton");
    const currentPick = draftOrder[currentPickIndex];
    const ownerId = currentPick ? getCurrentPickOwnerId(currentPick) : "";
    const announcementActive = Boolean(announcementPickNumber);
    const controlledTeamIds = getControlledTeamIds();
    const controlledTeamNames = controlledTeamIds
        .map(teamId => getTeamById(teamId)?.team_name)
        .filter(Boolean);

    document.querySelector("#controlledTeamLabel").textContent = controlledTeamNames.length
        ? `You control: ${controlledTeamNames.join(", ")}`
        : "You control: none";

    startButton.hidden = started;
    draftButton.hidden = !started || !currentPick || claimedTeams[ownerId] !== userId;
    draftButton.disabled = !selectedPlayer || announcementActive || !started || claimedTeams[ownerId] !== userId;
}

async function createRoom() {
    const response = await fetch("/api/mock/create-room", { method: "POST" });
    if (!response.ok) {
        alert("Failed to create mock room.");
        return;
    }
    const result = await response.json();
    window.location.href = `/mock/${result.roomCode}`;
}

function joinRoom() {
    const code = document.querySelector("#joinRoomInput").value.trim().toUpperCase();
    if (!code) return;
    window.location.href = `/mock/${code}`;
}

async function claimTeam(teamId) {
    const response = await fetch(`/api/mock/${roomCode}/claim-team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_id: teamId, user_id: userId })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Failed to control team.");
        return;
    }
    applyState(await response.json(), { forceRender: true });
}

async function startDraft() {
    const response = await fetch(`/api/mock/${roomCode}/start`, { method: "POST" });
    if (!response.ok) {
        alert("Failed to start mock draft.");
        return;
    }
    applyState(await response.json(), { forceRender: true });
}

async function sendTimerAction(action, seconds = null) {
    const response = await fetch(`/api/mock/${roomCode}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, seconds })
    });
    if (!response.ok) {
        alert("Failed to update timer.");
        return;
    }
    applyState(await response.json(), { forceRender: true });
}

async function makePick() {
    if (!selectedPlayer) return;
    const currentPick = draftOrder[currentPickIndex];
    if (!currentPick) return;
    const ownerId = getCurrentPickOwnerId(currentPick);
    const teamName = getTeamName(ownerId);
    const confirmed = confirm(`Draft ${selectedPlayer.name} to ${teamName} with the ${ordinal(Number(currentPick.pick_number))} overall pick?`);
    if (!confirmed) return;

    const response = await fetch(`/api/mock/${roomCode}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_name: selectedPlayer.name, player_key: selectedPlayer.player_key, user_id: userId })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Failed to make pick.");
        return;
    }

    selectedPlayer = null;
    document.querySelector("#selectedPlayer").textContent = "Click a player above to view details.";
    applyState(await response.json(), { forceRender: true });
}

async function resetDraft() {
    if (!confirm("Reset this mock draft? Team claims will stay, but picks will be cleared.")) return;
    const response = await fetch(`/api/mock/${roomCode}/reset`, { method: "POST" });
    if (response.ok) applyState(await response.json(), { forceRender: true });
}

async function undoPick() {
    if (!confirm("Undo the most recent mock draft pick?")) return;
    const response = await fetch(`/api/mock/${roomCode}/undo`, { method: "POST" });
    if (response.ok) applyState(await response.json(), { forceRender: true });
}

function setupEvents() {
    document.querySelector("#createMockRoomButton")?.addEventListener("click", createRoom);
    document.querySelector("#joinMockRoomButton")?.addEventListener("click", joinRoom);
    document.querySelector("#joinRoomInput")?.addEventListener("keydown", event => {
        if (event.key === "Enter") joinRoom();
    });
    document.querySelector("#copyRoomLinkButton")?.addEventListener("click", async () => {
        await navigator.clipboard.writeText(window.location.href);
        alert("Room link copied.");
    });
    document.querySelector("#startMockDraftButton")?.addEventListener("click", startDraft);
    document.querySelector("#draftButton")?.addEventListener("click", makePick);
    document.querySelector("#resetDraftButton")?.addEventListener("click", resetDraft);
    document.querySelector("#undoDraftButton")?.addEventListener("click", undoPick);
    document.querySelector("#startPauseTimerButton")?.addEventListener("click", () => sendTimerAction(timerRunning ? "pause" : "start"));
    document.querySelector("#resetTimerButton")?.addEventListener("click", () => sendTimerAction("reset"));
    document.querySelector("#setTimerLengthButton")?.addEventListener("click", () => {
        const input = prompt("Enter timer length in minutes:", timerDefaultSeconds / 60);
        if (input === null) return;
        const minutes = Number(input);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            alert("Please enter a valid number of minutes.");
            return;
        }
        sendTimerAction("set-length", Math.round(minutes * 60));
    });

    document.querySelector("#playerSearch")?.addEventListener("input", () => {
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
        if (matches.length > 0) resultsDiv.classList.add("has-results");
    });
}

setupEvents();
loadRoom();
setInterval(pollDraftState, 1000);
