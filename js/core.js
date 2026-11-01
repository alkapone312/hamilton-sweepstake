export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

export class TemplateRepository {
    constructor(names, translator) {
        this.names = names;
        this.translator = translator;
        this.templates = new Map();
    }

    async loadAll() {
        const items = await Promise.all(this.names.map(async (name) => {
            const response = await fetch("components/" + name + ".html", {
                cache: "no-store"
            });

            if (!response.ok) {
                throw new Error(this.translator.t("errors.client.templateLoad"));
            }

            return [name, await response.text()];
        }));

        this.templates = new Map(items);
    }

    render(name, properties = {}) {
        const template = this.templates.get(name);

        if (!template) {
            throw new Error(this.translator.t("errors.client.templateMissing"));
        }

        // Caller must escape user content before injecting template values.
        return this.translator.translateTemplate(template)
            .replace(/\{\{(\w+)\}\}/g, (_, key) => String(properties[key] ?? ""));
    }
}

export class ApiClient {
    constructor(translator) {
        this.translator = translator;
    }

    async request(action, data = {}) {
        const response = await fetch("api.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ action, ...data })
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error(this.translator.t("errors.client.invalidResponse"));
        }

        if (!response.ok || !result.ok) {
            const error = new Error(this.translator.t(
                result.error || "errors.client.http"
            ));
            error.status = response.status;
            throw error;
        }

        return result;
    }
}

export class SessionRepository {
    get rooms() {
        try {
            const value = JSON.parse(localStorage.getItem("hamiltonRooms") || "[]");
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    }

    saveRoom(room) {
        const rooms = [room, ...this.rooms.filter((item) => item.id !== room.id)];
        this.save("hamiltonRooms", JSON.stringify(rooms));
    }

    ownerToken(roomId) {
        return this.rooms.find((item) => item.id === roomId)?.token || null;
    }

    removeRoom(roomId) {
        this.save(
            "hamiltonRooms",
            JSON.stringify(this.rooms.filter((item) => item.id !== roomId))
        );
    }

    participant(roomId) {
        try {
            const value = JSON.parse(localStorage.getItem("hamiltonParticipant:" + roomId) || "null");

            return value && typeof value.token === "string" && typeof value.username === "string"
                ? value
                : null;
        } catch {
            return null;
        }
    }

    saveParticipant(roomId, participant) {
        this.save("hamiltonParticipant:" + roomId, JSON.stringify(participant));
    }

    verifyAvailable() {
        try {
            localStorage.setItem("hamiltonStorageTest", "1");
            localStorage.removeItem("hamiltonStorageTest");
        } catch {
            throw new Error("errors.client.storageUnavailable");
        }
    }

    save(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            throw new Error("errors.client.storageUnavailable");
        }
    }
}

export class DialogService {
    constructor(translator) {
        this.translator = translator;
        this.toastTimer = null;
    }

    open(html) {
        this.close();

        const overlay = document.createElement("div");
        overlay.className = "modal-backdrop";
        overlay.innerHTML = [
            '<section class="modal" role="dialog" aria-modal="true">',
            '    <button class="close" type="button" data-modal-close aria-label="' +
                escapeHtml(this.translator.t("common.close")) + '">×</button>',
            html,
            '</section>'
        ].join("\n");

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay || event.target.closest("[data-modal-close]")) {
                this.close();
            }
        });

        document.body.append(overlay);
        return overlay;
    }

    close() {
        document.querySelector(".modal-backdrop")?.remove();
    }

    notify(message) {
        const toast = document.getElementById("toast");
        toast.textContent = this.translator.t(message);
        toast.style.display = "block";
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.style.display = "none";
        }, 4500);
    }

    report(error) {
        console.error(error);
        this.notify(error?.message || String(error));
    }
}
