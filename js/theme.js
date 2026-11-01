/**
 * Independent light/dark switch, compatible with Chief's "theme" key.
 */
export class ThemeController {
    constructor(button, translator) {
        this.button = button;
        this.translator = translator;
    }

    init() {
        let dark = false;

        try {
            dark = localStorage.getItem("theme") === "dark";
        } catch {
            // Default to light if browser storage is blocked.
        }

        this.apply(dark);

        this.button.addEventListener("click", () => {
            const next = !document.documentElement.classList.contains("dark");
            this.apply(next);

            try {
                localStorage.setItem("theme", next ? "dark" : "light");
            } catch {
                // Current theme is still applied.
            }
        });
    }

    apply(dark) {
        document.documentElement.classList.toggle("dark", dark);
        document.body.classList.toggle("dark", dark);

        this.button.querySelector(".toggle-label").textContent = this.translator.t(
            dark ? "app.theme.dark" : "app.theme.light"
        );
        this.button.setAttribute("aria-label", this.translator.t(
            dark ? "app.theme.switchToLight" : "app.theme.switchToDark"
        ));
        this.button.setAttribute("aria-pressed", String(dark));
        document.querySelector('meta[name="theme-color"]').content = dark
            ? "#111d18"
            : "#f5f4ed";
    }
}
