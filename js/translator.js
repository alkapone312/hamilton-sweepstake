export class Translator {
    static LANGUAGES = ["pl_PL", "en_GB"];
    static STORAGE_KEY = "hamiltonLanguage";

    constructor() {
        this.language = this.readLanguage();
        this.dictionary = {};
    }

    readLanguage() {
        try {
            const saved = localStorage.getItem(Translator.STORAGE_KEY);
            return Translator.LANGUAGES.includes(saved) ? saved : "pl_PL";
        } catch {
            return "pl_PL";
        }
    }

    async load() {
        const response = await fetch("translations/" + this.language + ".json", {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Could not load the translations.");
        }

        this.dictionary = await response.json();
        document.documentElement.lang = this.language === "pl_PL" ? "pl" : "en-GB";
    }

    t(key, params = {}) {
        let value = key.split(".").reduce(
            (current, name) => current && current[name],
            this.dictionary
        );

        if (typeof value !== "string") {
            return key;
        }

        for (const [name, replacement] of Object.entries(params)) {
            value = value.replaceAll("{" + name + "}", String(replacement));
        }

        return value;
    }

    translateTemplate(html) {
        return html.replace(/\$t\('([^']+)'\)/g, (_, key) => this.t(key));
    }

    applyStaticTranslations() {
        document.querySelectorAll("[data-i18n]").forEach((element) => {
            element.textContent = this.t(element.dataset.i18n);
        });
    }

    selectLanguage(language) {
        if (!Translator.LANGUAGES.includes(language)) {
            return;
        }

        try {
            localStorage.setItem(Translator.STORAGE_KEY, language);
        } catch {
            // It will remain usable for this page without persistence.
        }

        location.reload();
    }
}
