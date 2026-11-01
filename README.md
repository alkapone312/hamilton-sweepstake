# Hamilton Sweepstake — prywatne losowanie cyklu

> **Projekt przygotowany z pomocą AI.** Przed publicznym wdrożeniem zalecany jest niezależny przegląd bezpieczeństwa i testy środowiskowe.

Hamilton Sweepstake to samodzielna aplikacja HTML + CSS + JavaScript + PHP. Aplikacja działa bez frameworka, Composera, zewnętrznych bibliotek czy procesu budowania frontendu.

## Funkcje

- Twórca zakłada pokój i dostaje prywatny token administratora (przechowywany jako hash SHA-256 w bazie).
- Pokój ma link, który można przekazać uczestnikom.
- Każdy uczestnik wybiera unikalny w pokoju login i dostaje indywidualny, losowy token. Login jest porównywany bez uwzględniania wielkości liter (pełna obsługa Unicode wymaga PHP `mbstring`).
- Wszystkie przeglądarki widzą publiczną listę uczestników; stan jest odświeżany co 3 sekundy **do momentu pobrania wyniku**.
- Pokój wygasa po **60 minutach bez nowej rejestracji**. Utworzenie pokoju uruchamia licznik, każda pomyślna rejestracja ustawia go ponownie na 60 minut. Tylko twórca widzi aktualizowany co sekundę licznik `HH:MM:SS`.
- Jedynie twórca uruchamia losowanie (minimum 2, maksimum 300 uczestników). Przycisk można kliknąć, gdy wszyscy zostali wpisani, według decyzji twórcy.
- Losowanie tasuje uczestników i łączy każdego z następnym w jednej cyklicznej permutacji.
- Powstaje **jeden skierowany cykl Hamiltona**. Każdy ma dokładnie jedną krawędź wychodzącą i jedną przychodzącą; nikt nie trafia na siebie.
- Każdy uczestnik może odczytać **wyłącznie swój** wynik przez `my_result` z indywidualnym tokenem.
- Po pobraniu wyniku przez daną osobę serwer odnotowuje ten odczyt, a jej przeglądarka **kończy polling**. Wynik pozostaje widoczny w otwartej karcie, bez zapisywania przydziału w localStorage.
- Kiedy **wszyscy** uczestnicy pobiorą wynik, ostatnie wywołanie `my_result` zwraca ostatni wynik i **usuwa cały pokój wraz z uczestnikami** w jednej transakcji SQLite. Ten mechanizm działa niezależnie od godzinnego limitu. Po ponownym wejściu API zwraca **404**, a strona wyświetla ekran „404”.
- Losowanie jest jednorazowe; po zakończeniu lista zostaje zamknięta.
- Motyw jasny/ciemny i polski/angielski interfejs.

## Wymagania i uruchomienie

- PHP 8.1+ i rozszerzenia `PDO` / `pdo_sqlite`.
- Zapisywalny katalog na SQLite **poza katalogiem publicznym**.
- Nowoczesna przeglądarka z obsługą modułów ES, Fetch i localStorage.

`DB_FILE` jest wymagane. Musi być absolutną ścieżką do pliku `.sqlite`; katalog nadrzędny musi już istnieć.

```bash
cd /home/jakub/Projects/www/chafften.net/hamilton
mkdir -p /tmp/hamilton-private
export DB_FILE="/tmp/hamilton-private/hamilton.sqlite"
php -S 127.0.0.1:8000
```

Otwórz `http://127.0.0.1:8000/`. Serwer wbudowany PHP służy do programowania, a nie produkcji. Dla testów z innych urządzeń wystaw serwer pod adresem dostępnym w LAN.

Domyślny prefiks tabel to `hamilton_`. Można go nadpisać przez `HAMILTON_DB_TABLE_PREFIX`, a potem `DB_TABLE_PREFIX`. Prefiks musi zawierać maksymalnie 32 znaki ASCII, zaczynać się literą lub podkreśleniem, a dalej może zawierać litery, cyfry i podkreślenia. Tabele tworzą się automatycznie.

## Wygasanie bezczynnych pokoi

- `expires_at` jest zapisany w tabeli pokojów jako uniksowy czas wygaśnięcia (w sekundach).
- Dla nowego pokoju wynosi `time() + 3600`. Każde **udane** `join_room` aktualizuje tę wartość na kolejne 3600 sekund. Nie robią tego `get_room`, nieudana rejestracja, losowanie ani odczyt wyniku.
- `get_room` zwraca `expiresAt` i `serverTime` **wyłącznie po podaniu poprawnego `ownerToken`**; uczestnicy nie widzą licznika. Przeglądarka twórcy oblicza czas na podstawie zegara serwera i odświeża widok co sekundę.
- Po terminie wszystkie akcje na tym pokoju kończą się **404**. Usunięcie rekordu pokoju usuwa też uczestników i wyniki dzięki `ON DELETE CASCADE`. Przeglądarki z już odebranym wynikiem nie wysyłają kolejnych zapytań i utrzymują go w otwartej karcie.
- Skrypt `api.php` czyści przeterminowane pokoje przy każdej próbie użycia API.

## Struktura katalogu

```text
hamilton/                      Projekt Hamilton Sweepstake
    api.php                         Całe API i logika bazy danych
    index.html                      Powłoka strony
    style.css                       RWD, styl Chief, motyw jasny/ciemny
    app.js                          Routing i kontrolery
    js/
        core.js                     API, sesje, szablony i dialogi
        translator.js               Lokalizacja UI
        theme.js                    Przełącznik motywu
    components/
        home.html                   Widok główny
        new-room.html               Formularz nowego pokoju
        room.html                   Pokój, lista, udział, wynik i panel twórcy
    translations/
        pl_PL.json
        en_GB.json
    tests/
        api.integration.test.mjs    Test izolowanego cyklu i kontroli dostępu
    package.json
    README.md
    chief/                          Projekt referencyjny (niezmieniany)
```

## API JSON

Wszystkie akcje to `POST api.php` z nagłówkiem `Content-Type: application/json` i polem `action`:

| Akcja | Wymagane pola | Wynik |
| --- | --- | --- |
| `create_room` | `name` | `roomId`, `ownerToken`, publiczne dane pokoju |
| `get_room` | `roomId`; opcjonalny `ownerToken` | nazwa, status, lista loginów i liczba uczestników; `expiresAt` oraz `serverTime` tylko dla twórcy |
| `join_room` | `roomId`, `username` | `participantToken`, `username` |
| `draw_room` | `roomId`, `ownerToken` | tylko potwierdzenie i liczba osób |
| `my_result` | `roomId`, `participantToken` | własna nazwa i `assignedName` lub `null` przed losowaniem; po pobraniu przez ostatnią osobę usuwa pokój |

Błędy mają postać `{"ok":false,"error":"errors.api.usernameTaken"}`, tłumaczoną przez przeglądarkę. API nigdy nie udostępnia publicznie całego losowania, również twórcy pokoju.

## Prywatność i ograniczenia

Token twórcy i token uczestnika są zapisywane w `localStorage` odpowiedniej przeglądarki. **Sam wylosowany wynik nie jest utrwalany** — jest widoczny wyłącznie na otwartej stronie i znika po jej zamknięciu lub odświeżeniu (odświeżenie przed usunięciem pokoju może pobrać wynik jeszcze raz). Po utracie tokenu nie można go odzyskać. **Link do pokoju nie zawiera żadnego z tokenów.** Każdy, kto ma token uczestnika, może odczytać jego wynik; tokeny należy chronić, stosować HTTPS i nie udostępniać nieuprawnionym osobom.

Aplikacja nie używa kont użytkowników i nie potwierdza tożsamości. Może zapobiec powtórnemu użyciu tej samej nazwy, ale nie może powstrzymać kogoś przed wpisaniem kilku różnych nazw ani udawaniem innej osoby. Twórca sam decyduje, kiedy lista jest kompletna. Pokój nie ma automatycznej daty wygaśnięcia, zarządzania uczestnikami ani funkcji ponownego losowania.

## Testy

Wymagany Node.js 20+ (tylko do testów), PHP CLI i `pdo_sqlite`.

```bash
npm test
```

Test integracyjny tworzy tymczasową bazę, uruchamia lokalny serwer PHP, weryfikuje listę uczestników, brak duplikatów, odmowę nieuprawnionego losowania, **dokładnie jeden** cykl Hamiltona, poufność wyników, brak wcześniejszego usunięcia, prawidłowy ostatni wynik i odpowiedź **404** po usunięciu pokoju. Nie używa produkcyjnej bazy.
