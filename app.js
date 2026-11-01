import {
    ApiClient,
    DialogService,
    SessionRepository,
    TemplateRepository,
    escapeHtml
} from "./js/core.js";
import { ThemeController } from "./js/theme.js";
import { Translator } from "./js/translator.js";

function roomUrl(roomId) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("room", roomId);

    return url.toString();
}

class RoomController {
    constructor(root, services, roomId) {
        this.root = root;
        this.services = services;
        this.roomId = roomId;
        this.rendered = false;
        this.refreshing = false;
        this.drawing = false;
        this.resultAccessError = false;
        this.resultReceived = false;
        this.roomMissing = false;
        this.lastPeople = null;
        this.lastError = null;
        this.expiryDeadline = null;
    }

    get t() {
        return this.services.translator.t.bind(this.services.translator);
    }

    get member() {
        return this.services.session.participant(this.roomId);
    }

    get ownerToken() {
        return this.services.session.ownerToken(this.roomId);
    }

    async start() {
        await this.refresh();

        if (this.ownerToken && !this.roomMissing) {
            this.countdownInterval = setInterval(() => this.updateCountdown(), 1000);
        }

        if (this.resultReceived || this.roomMissing) {
            return;
        }

        this.interval = setInterval(() => {
            this.refresh().catch((error) => {
                // Repeated offline polls should not show an endless toast loop.
                if (error.message !== this.lastError) {
                    this.services.dialog.report(error);
                    this.lastError = error.message;
                }
            });
        }, 3000);

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && !this.resultReceived && !this.roomMissing) {
                this.refresh().catch((error) => this.services.dialog.report(error));
            }
        });
    }

    bindEvents() {
        this.root.querySelector("#join-form").addEventListener("submit", (event) => {
            event.preventDefault();
            this.join(event.currentTarget).catch((error) => this.services.dialog.report(error));
        });

        this.root.querySelector("#draw-button").addEventListener("click", () => {
            this.draw().catch((error) => this.services.dialog.report(error));
        });

        this.root.querySelector("#copy-url").addEventListener("click", () => {
            this.copyLink().catch((error) => this.services.dialog.report(error));
        });

        this.root.querySelector("#room-share-url").value = roomUrl(this.roomId);
    }

    async refresh() {
        if (this.refreshing || this.resultReceived || this.roomMissing) {
            return;
        }

        this.refreshing = true;

        try {
            let response;

            try {
                response = await this.services.api.request("get_room", {
                    roomId: this.roomId,
                    ...(this.ownerToken ? { ownerToken: this.ownerToken } : {})
                });
            } catch (error) {
                if (error.status !== 404) {
                    throw error;
                }

                this.roomMissing = true;
                clearInterval(this.interval);
                clearInterval(this.countdownInterval);

                try {
                    this.services.session.removeRoom(this.roomId);
                } catch {
                    // The room is already gone, even if local storage is blocked.
                }

                this.root.innerHTML = [
                    '<div class="empty">',
                    '    <strong>404</strong>',
                    '    <p>' + escapeHtml(this.t("errors.api.roomNotFound")) + '</p>',
                    '    <p><a href="./">' + escapeHtml(this.t("app.backHome")) + '</a></p>',
                    '</div>'
                ].join("\n");
                return;
            }

            if (!this.rendered) {
                this.root.innerHTML = this.services.templates.render("room");
                this.bindEvents();
                this.rendered = true;
            }

            this.room = response.room;

            if (this.ownerToken && Number.isInteger(this.room.expiresAt) &&
                Number.isInteger(this.room.serverTime)) {
                // Use the server's remaining time, not the phone's clock.
                this.expiryDeadline = performance.now() + Math.max(
                    0, this.room.expiresAt - this.room.serverTime
                ) * 1000;
            }

            this.paint();
            this.lastError = null;

            if (this.member && this.room.status === "drawn" && !this.resultAccessError) {
                try {
                    const result = await this.services.api.request("my_result", {
                        roomId: this.roomId,
                        participantToken: this.member.token
                    });

                    this.paintResult(result);
                } catch (error) {
                    this.resultAccessError = true;
                    this.root.querySelector("#result-pending strong").textContent =
                        this.t("errors.api.participantRequired");
                    this.root.querySelector("#result-pending .side-note").hidden = true;
                    this.services.dialog.report(error);
                }
            }
        } finally {
            this.refreshing = false;
        }
    }

    paint() {
        const room = this.room;
        const member = this.member;
        const finished = room.status === "drawn";

        this.root.querySelector("#room-title").textContent = room.name;
        document.title = room.name + " — Hamilton Sweepstake";
        this.root.querySelector("#room-count").textContent = String(room.participantCount);

        const status = this.root.querySelector("#room-status");
        status.textContent = this.t(finished ? "room.drawn" : "room.waiting");
        status.classList.toggle("done", finished);

        const peopleKey = JSON.stringify([room.participants, member?.username]);

        if (peopleKey !== this.lastPeople) {
            this.lastPeople = peopleKey;
            this.root.querySelector("#people-list").innerHTML = room.participants.length
                ? room.participants.map((username, index) => [
                    '<div class="person">',
                    '    <span class="person-index">' + (index + 1) + '</span>',
                    '    <span class="person-name">' + escapeHtml(username) + '</span>',
                    member?.username === username
                        ? '    <span class="eyebrow" style="margin:0 0 0 auto">' +
                            escapeHtml(this.t("common.you")) + '</span>'
                        : "",
                    '</div>'
                ].join("\n")).join("")
                : [
                    '<div class="empty">',
                    '    <strong>' + escapeHtml(this.t("common.noPeople")) + '</strong>',
                    '    <p>' + escapeHtml(this.t("common.firstPerson")) + '</p>',
                    '</div>'
                ].join("\n");
        }

        this.root.querySelector("#join-panel").hidden = Boolean(member) || finished;
        this.root.querySelector("#member-panel").hidden = !member;
        this.root.querySelector("#closed-panel").hidden = Boolean(member) || !finished;

        if (member) {
            this.root.querySelector("#member-username").textContent = member.username;
        }

        const ownerPanel = this.root.querySelector("#owner-panel");
        ownerPanel.hidden = !this.ownerToken;

        if (this.ownerToken) {
            this.updateCountdown();
            const button = this.root.querySelector("#draw-button");
            const hint = this.root.querySelector("#draw-hint");

            button.disabled = finished || room.participantCount < 2 || this.drawing;
            hint.textContent = finished
                ? this.t("owner.finished")
                : room.participantCount < 2
                    ? this.t("owner.notEnough")
                    : this.t("owner.ready", { count: room.participantCount });
        }
    }

    updateCountdown() {
        if (!this.ownerToken || this.roomMissing || this.expiryDeadline === null) {
            return;
        }

        const element = this.root.querySelector("#room-countdown");

        if (!element) {
            return;
        }

        const seconds = Math.max(
            0,
            Math.ceil((this.expiryDeadline - performance.now()) / 1000)
        );
        const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
        const remainder = String(seconds % 60).padStart(2, "0");

        element.textContent = hours + ":" + minutes + ":" + remainder;
    }

    paintResult(result) {
        const ready = typeof result.assignedName === "string";
        this.root.querySelector("#result-pending").hidden = ready;
        this.root.querySelector("#result-ready").hidden = !ready;

        if (ready) {
            // Keep the delivered result only in the currently open page. Once
            // the server deletes the room, this view must remain unchanged.
            this.root.querySelector("#assigned-name").textContent = result.assignedName;
            this.root.querySelector(".section-heading.compact .overline").hidden = true;
            this.resultReceived = true;
            clearInterval(this.interval);
        }
    }

    async join(form) {
        const username = form.querySelector("#join-username").value.trim();

        if (!username) {
            return;
        }

        const button = form.querySelector('[type="submit"]');
        button.disabled = true;

        try {
            this.services.session.verifyAvailable();

            const response = await this.services.api.request("join_room", {
                roomId: this.roomId,
                username
            });

            this.services.session.saveParticipant(this.roomId, {
                username: response.username,
                token: response.participantToken
            });
            this.services.dialog.notify("join.welcome");
            await this.refresh();
        } finally {
            button.disabled = false;
        }
    }

    async draw() {
        if (!this.ownerToken || this.drawing ||
            this.room.status !== "waiting" || this.room.participantCount < 2) {
            return;
        }

        if (!confirm(this.t("common.confirmDraw"))) {
            return;
        }

        this.drawing = true;
        this.paint();

        try {
            await this.services.api.request("draw_room", {
                roomId: this.roomId,
                ownerToken: this.ownerToken
            });

            await this.refresh();
        } finally {
            this.drawing = false;
            this.paint();
        }
    }

    async copyLink() {
        const url = roomUrl(this.roomId);

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(url);
            } else {
                const input = this.root.querySelector("#room-share-url");
                input.focus();
                input.select();

                if (!document.execCommand("copy")) {
                    throw new Error("Copy failed");
                }
            }

            this.services.dialog.notify("common.copied");
        } catch {
            throw new Error(this.t("errors.client.copyFailed"));
        }
    }
}

class HamiltonSweepstakeApplication {
    constructor(root) {
        this.root = root;
        const translator = new Translator();

        this.services = {
            translator,
            api: new ApiClient(translator),
            dialog: new DialogService(translator),
            session: new SessionRepository(),
            templates: new TemplateRepository(["home", "new-room", "room"], translator)
        };

        this.root.addEventListener("click", (event) => {
            if (event.target.closest('[data-action="create-room"]')) {
                this.openCreateRoom();
            }
        });
    }

    async start() {
        await this.services.translator.load();
        this.services.translator.applyStaticTranslations();

        new ThemeController(
            document.getElementById("theme-toggle"),
            this.services.translator
        ).init();

        const selector = document.getElementById("language-select");
        selector.value = this.services.translator.language;
        selector.addEventListener("change", (event) => {
            this.services.translator.selectLanguage(event.target.value);
        });

        await this.services.templates.loadAll();

        const roomId = new URLSearchParams(location.search).get("room");

        if (roomId !== null) {
            this.controller = new RoomController(this.root, this.services, roomId);
            await this.controller.start();
        } else {
            this.renderHome();
        }
    }

    renderHome() {
        const t = (key, params) => this.services.translator.t(key, params);
        const saved = this.services.session.rooms;

        const roomCards = saved.length ? [
            '<div class="section-heading">',
            '    <h2>' + escapeHtml(t("home.yourRooms")) + '</h2>',
            '    <span class="muted">' + escapeHtml(t("home.savedHere")) + '</span>',
            '</div>',
            '<div class="rooms">',
            ...saved.map((room) => [
                '<article class="tile">',
                '    <span class="eyebrow">' + escapeHtml(t("home.yourRoom")) + '</span>',
                '    <h3>' + escapeHtml(room.name) + '</h3>',
                '    <p>' + escapeHtml(t("home.code", { id: room.id })) + '</p>',
                '    <div class="actions"><a class="btn dark small" href="' +
                    escapeHtml(roomUrl(room.id)) + '">' + escapeHtml(t("home.open")) + '</a></div>',
                '</article>'
            ].join("\n")),
            '</div>'
        ].join("\n") : "";

        this.root.innerHTML = this.services.templates.render("home", {
            savedRooms: roomCards
        });
    }

    openCreateRoom() {
        const dialog = this.services.dialog;
        const overlay = dialog.open(this.services.templates.render("new-room"));
        const form = overlay.querySelector("#create-room-form");

        form.addEventListener("submit", (event) => {
            event.preventDefault();
            this.createRoom(form).catch((error) => dialog.report(error));
        });

        overlay.querySelector("#new-room-name").focus();
    }

    async createRoom(form) {
        const name = form.querySelector("#new-room-name").value.trim();

        if (!name) {
            return;
        }

        const button = form.querySelector('[type="submit"]');
        button.disabled = true;

        try {
            this.services.session.verifyAvailable();

            const result = await this.services.api.request("create_room", { name });
            this.services.session.saveRoom({
                id: result.roomId,
                name: result.room.name,
                token: result.ownerToken
            });

            location.href = roomUrl(result.roomId);
        } finally {
            button.disabled = false;
        }
    }
}

const root = document.getElementById("app");
const app = new HamiltonSweepstakeApplication(root);

app.start().catch((error) => {
    console.error(error);
    root.innerHTML = [
        '<div class="empty">',
        '    <strong>' + escapeHtml(
            error.status === 404 ? "404" : app.services.translator.t("app.unavailable")
        ) + '</strong>',
        '    <p>' + escapeHtml(app.services.translator.t(error.message)) + '</p>',
        '    <p><a href="./">' + escapeHtml(app.services.translator.t("app.backHome")) + '</a></p>',
        '</div>'
    ].join("\n");
});
