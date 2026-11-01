<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

final class ApiException extends RuntimeException
{
    public function __construct(string $message, public readonly int $statusCode = 400)
    {
        parent::__construct($message);
    }
}

final class Text
{
    public static function length(string $value): int
    {
        return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
    }

    public static function label(mixed $value, int $maximum, string $error): string
    {
        if (!is_string($value)) {
            throw new ApiException($error);
        }

        $label = trim($value);

        if ($label === '' || preg_match('//u', $label) !== 1 ||
            preg_match('/[\x00-\x1F\x7F]/u', $label) === 1 ||
            self::length($label) > $maximum) {
            throw new ApiException($error);
        }

        return $label;
    }

    public static function usernameKey(string $name): string
    {
        if (class_exists('Normalizer')) {
            $normalized = Normalizer::normalize($name, Normalizer::FORM_C);

            if ($normalized !== false) {
                $name = $normalized;
            }
        }

        return function_exists('mb_strtolower')
            ? mb_strtolower($name, 'UTF-8')
            : strtolower($name);
    }
}

final class Database
{
    public readonly PDO $connection;
    private readonly string $tablePrefix;
    public const ROOM_IDLE_SECONDS = 3600;

    public function __construct()
    {
        $prefix = getenv('HAMILTON_DB_TABLE_PREFIX');

        if ($prefix === false) {
            $prefix = getenv('DB_TABLE_PREFIX');
        }

        $this->tablePrefix = $prefix === false ? 'hamilton_' : $prefix;

        if ($this->tablePrefix !== '' &&
            preg_match('/\A[A-Za-z_][A-Za-z0-9_]{0,31}\z/D', $this->tablePrefix) !== 1) {
            throw new RuntimeException('Invalid database table prefix.');
        }

        $path = getenv('DB_FILE');

        if ($path === false || trim($path) === '' ||
            !str_starts_with($path, '/') ||
            str_contains($path, "\0") ||
            !str_ends_with(strtolower($path), '.sqlite')) {
            throw new RuntimeException('DB_FILE must be an absolute .sqlite file path.');
        }

        $directory = dirname($path);

        if (!is_dir($directory) || !is_writable($directory)) {
            throw new RuntimeException('The database directory must exist and be writable.');
        }

        $this->connection = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
        ]);

        $this->initialize();
    }

    /**
     * SQL identifiers cannot be bound with placeholders. Only identifiers
     * from this allowlist, with the validated prefix, are ever interpolated.
     */
    public function table(string $name): string
    {
        if (!in_array($name, [
            'rooms', 'participants', 'idx_participants_room', 'idx_participants_token',
            'idx_rooms_expires_at'
        ], true)) {
            throw new InvalidArgumentException('Unknown database identifier.');
        }

        return '"' . $this->tablePrefix . $name . '"';
    }

    private function initialize(): void
    {
        $rooms = $this->table('rooms');
        $participants = $this->table('participants');
        $roomIndex = $this->table('idx_participants_room');
        $tokenIndex = $this->table('idx_participants_token');
        $expiryIndex = $this->table('idx_rooms_expires_at');

        $this->connection->exec(
            'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;'
        );

        $this->connection->exec(
            "CREATE TABLE IF NOT EXISTS {$rooms} (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'drawn')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                drawn_at TEXT,
                expires_at INTEGER
            )"
        );

        // Existing rooms receive a one-hour grace period on first deployment,
        // rather than expiring immediately during the schema migration.
        $roomColumns = $this->connection->query(
            "PRAGMA table_info({$rooms})"
        )->fetchAll();

        if (!in_array('expires_at', array_column($roomColumns, 'name'), true)) {
            $this->connection->exec(
                "ALTER TABLE {$rooms} ADD COLUMN expires_at INTEGER"
            );
        }

        $this->execute(
            "UPDATE {$rooms} SET expires_at = ? WHERE expires_at IS NULL",
            [time() + self::ROOM_IDLE_SECONDS]
        );

        $this->connection->exec(
            "CREATE INDEX IF NOT EXISTS {$expiryIndex} ON {$rooms}(expires_at)"
        );

        $this->connection->exec(
            "CREATE TABLE IF NOT EXISTS {$participants} (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES {$rooms}(id) ON DELETE CASCADE,
                username TEXT NOT NULL,
                username_key TEXT NOT NULL,
                token_hash TEXT NOT NULL,
                next_id TEXT REFERENCES {$participants}(id),
                joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                result_read_at TEXT,
                UNIQUE (room_id, username_key)
            )"
        );

        // Keep existing rooms when upgrading from versions without read tracking.
        $columns = $this->connection->query(
            "PRAGMA table_info({$participants})"
        )->fetchAll();

        if (!in_array('result_read_at', array_column($columns, 'name'), true)) {
            $this->connection->exec(
                "ALTER TABLE {$participants} ADD COLUMN result_read_at TEXT"
            );
        }

        $this->connection->exec(
            "CREATE INDEX IF NOT EXISTS {$roomIndex} ON {$participants}(room_id, joined_at)"
        );
        $this->connection->exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS {$tokenIndex} ON {$participants}(token_hash)"
        );

        // Every API request removes abandoned rooms; no polling extends TTL.
        $this->deleteExpiredRooms();
    }

    public function deleteExpiredRooms(): int
    {
        $rooms = $this->table('rooms');

        return $this->execute(
            "DELETE FROM {$rooms} WHERE expires_at <= ?",
            [time()]
        );
    }

    public function find(string $sql, array $values = []): ?array
    {
        $statement = $this->connection->prepare($sql);
        $statement->execute($values);

        return $statement->fetch() ?: null;
    }

    public function all(string $sql, array $values = []): array
    {
        $statement = $this->connection->prepare($sql);
        $statement->execute($values);

        return $statement->fetchAll();
    }

    public function execute(string $sql, array $values = []): int
    {
        $statement = $this->connection->prepare($sql);
        $statement->execute($values);

        return $statement->rowCount();
    }

    /**
     * IMMEDIATE locks the writer before checking the room state, preventing
     * a late join from racing the draw on concurrent PHP workers.
     */
    public function transaction(callable $action): mixed
    {
        $this->connection->exec('BEGIN IMMEDIATE');

        try {
            $result = $action();
            $this->connection->exec('COMMIT');

            return $result;
        } catch (Throwable $error) {
            $this->connection->exec('ROLLBACK');
            throw $error;
        }
    }
}

final class HamiltonApi
{
    public function __construct(private readonly Database $database)
    {
    }

    public function handle(array $request): array
    {
        $action = $request['action'] ?? null;

        if ($action === 'create_room') {
            return $this->createRoom($request);
        }

        $roomId = $request['roomId'] ?? null;

        if (!is_string($roomId) || preg_match('/\A[a-f0-9]{14}\z/D', $roomId) !== 1) {
            throw new ApiException('errors.api.roomNotFound', 404);
        }

        return match ($action) {
            'get_room' => $this->getRoom($roomId, $request),
            'join_room' => $this->joinRoom($roomId, $request),
            'my_result' => $this->myResult($roomId, $request),
            'draw_room' => $this->drawRoom($roomId, $request),
            default => throw new ApiException('errors.api.unknownAction', 404)
        };
    }

    private function findRoom(string $roomId): array
    {
        $rooms = $this->database->table('rooms');
        $room = $this->database->find(
            "SELECT id, name, owner_hash, status, drawn_at, expires_at
             FROM {$rooms} WHERE id = ? AND expires_at > ?",
            [$roomId, time()]
        );

        if (!$room) {
            throw new ApiException('errors.api.roomNotFound', 404);
        }

        return $room;
    }

    private function requireOwner(array $room, array $request): void
    {
        $token = $request['ownerToken'] ?? null;

        if (!is_string($token) ||
            !hash_equals($room['owner_hash'], hash('sha256', $token))) {
            throw new ApiException('errors.api.ownerRequired', 403);
        }
    }

    private function createRoom(array $request): array
    {
        $name = Text::label($request['name'] ?? null, 100, 'errors.api.invalidRoomName');
        $roomId = bin2hex(random_bytes(7));
        $ownerToken = bin2hex(random_bytes(32));
        $rooms = $this->database->table('rooms');

        $this->database->execute(
            "INSERT INTO {$rooms} (id, name, owner_hash, expires_at)
             VALUES (?, ?, ?, ?)",
            [
                $roomId,
                $name,
                hash('sha256', $ownerToken),
                time() + Database::ROOM_IDLE_SECONDS
            ]
        );

        return [
            'roomId' => $roomId,
            'ownerToken' => $ownerToken,
            'room' => [
                'id' => $roomId,
                'name' => $name,
                'status' => 'waiting',
                'participants' => [],
                'participantCount' => 0
            ]
        ];
    }

    private function getRoom(string $roomId, array $request): array
    {
        $room = $this->findRoom($roomId);
        $participants = $this->database->table('participants');

        $people = $this->database->all(
            "SELECT username FROM {$participants} WHERE room_id = ?
             ORDER BY joined_at ASC, rowid ASC",
            [$roomId]
        );

        $public = [
            'id' => $room['id'],
            'name' => $room['name'],
            'status' => $room['status'],
            'participantCount' => count($people),
            'participants' => array_column($people, 'username')
        ];

        // The inactivity countdown is available only with the owner's token.
        $ownerToken = $request['ownerToken'] ?? null;

        if (is_string($ownerToken) &&
            hash_equals($room['owner_hash'], hash('sha256', $ownerToken))) {
            $public['expiresAt'] = (int) $room['expires_at'];
            $public['serverTime'] = time();
        }

        return ['room' => $public];
    }

    private function joinRoom(string $roomId, array $request): array
    {
        $username = Text::label($request['username'] ?? null, 40, 'errors.api.invalidUsername');
        $key = Text::usernameKey($username);
        $participants = $this->database->table('participants');

        return $this->database->transaction(function () use (
            $roomId, $username, $key, $participants
        ): array {
            $room = $this->findRoom($roomId);

            if ($room['status'] !== 'waiting') {
                throw new ApiException('errors.api.registrationClosed', 409);
            }

            $existing = $this->database->find(
                "SELECT id FROM {$participants} WHERE room_id = ? AND username_key = ?",
                [$roomId, $key]
            );

            if ($existing) {
                throw new ApiException('errors.api.usernameTaken', 409);
            }

            $count = $this->database->find(
                "SELECT COUNT(*) AS total FROM {$participants} WHERE room_id = ?",
                [$roomId]
            );

            if ((int) $count['total'] >= 300) {
                throw new ApiException('errors.api.roomFull', 409);
            }

            $participantId = bin2hex(random_bytes(12));
            $participantToken = bin2hex(random_bytes(32));

            $this->database->execute(
                "INSERT INTO {$participants} (id, room_id, username, username_key, token_hash)
                 VALUES (?, ?, ?, ?, ?)",
                [
                    $participantId,
                    $roomId,
                    $username,
                    $key,
                    hash('sha256', $participantToken)
                ]
            );

            // Only a successful new registration resets the one-hour timer.
            $rooms = $this->database->table('rooms');
            $this->database->execute(
                "UPDATE {$rooms} SET expires_at = ? WHERE id = ?",
                [time() + Database::ROOM_IDLE_SECONDS, $roomId]
            );

            return ['participantToken' => $participantToken, 'username' => $username];
        });
    }

    private function myResult(string $roomId, array $request): array
    {
        $token = $request['participantToken'] ?? null;

        if (!is_string($token) || preg_match('/\A[a-f0-9]{64}\z/D', $token) !== 1) {
            throw new ApiException('errors.api.participantRequired', 403);
        }

        // A result is marked as retrieved only after the draw. The final
        // retrieval deletes the room in the same write transaction; that
        // response still contains the final participant's assignment.
        return $this->database->transaction(function () use ($roomId, $token): array {
            $room = $this->findRoom($roomId);
            $participants = $this->database->table('participants');
            $participant = $this->database->find(
                "SELECT me.id, me.username, recipient.username AS assigned_name
                 FROM {$participants} AS me
                 LEFT JOIN {$participants} AS recipient
                    ON recipient.id = me.next_id AND recipient.room_id = me.room_id
                 WHERE me.room_id = ? AND me.token_hash = ?",
                [$roomId, hash('sha256', $token)]
            );

            if (!$participant) {
                throw new ApiException('errors.api.participantRequired', 403);
            }

            $result = [
                'username' => $participant['username'],
                'assignedName' => $participant['assigned_name']
            ];

            if ($room['status'] !== 'drawn') {
                return $result;
            }

            if (!is_string($result['assignedName'])) {
                throw new RuntimeException('Drawn participant has no assignment.');
            }

            $this->database->execute(
                "UPDATE {$participants}
                 SET result_read_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND room_id = ? AND result_read_at IS NULL",
                [$participant['id'], $roomId]
            );

            $remaining = $this->database->find(
                "SELECT COUNT(*) AS total FROM {$participants}
                 WHERE room_id = ? AND result_read_at IS NULL",
                [$roomId]
            );

            if ((int) $remaining['total'] === 0) {
                $rooms = $this->database->table('rooms');
                // ON DELETE CASCADE also removes every participant and assignment.
                $this->database->execute("DELETE FROM {$rooms} WHERE id = ?", [$roomId]);
            }

            return $result;
        });
    }

    private function drawRoom(string $roomId, array $request): array
    {
        return $this->database->transaction(function () use ($roomId, $request): array {
            $room = $this->findRoom($roomId);
            $this->requireOwner($room, $request);

            if ($room['status'] !== 'waiting') {
                throw new ApiException('errors.api.alreadyDrawn', 409);
            }

            $participants = $this->database->table('participants');
            $rooms = $this->database->table('rooms');
            $people = $this->database->all(
                "SELECT id FROM {$participants} WHERE room_id = ? ORDER BY id",
                [$roomId]
            );
            $count = count($people);

            if ($count < 2) {
                throw new ApiException('errors.api.notEnoughPeople', 409);
            }

            // A uniformly shuffled permutation defines one directed Hamiltonian
            // cycle: every vertex has exactly one successor and predecessor.
            for ($i = $count - 1; $i > 0; $i--) {
                $j = random_int(0, $i);
                [$people[$i], $people[$j]] = [$people[$j], $people[$i]];
            }

            for ($i = 0; $i < $count; $i++) {
                $next = $people[($i + 1) % $count]['id'];
                $updated = $this->database->execute(
                    "UPDATE {$participants} SET next_id = ? WHERE id = ? AND room_id = ?",
                    [$next, $people[$i]['id'], $roomId]
                );

                if ($updated !== 1) {
                    throw new RuntimeException('Could not save the drawing.');
                }
            }

            $this->database->execute(
                "UPDATE {$rooms} SET status = 'drawn', drawn_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'waiting'",
                [$roomId]
            );

            // Never return the permutation, not even to the room owner.
            return ['drawn' => true, 'participantCount' => $count];
        });
    }
}

// Optional cron entry point removes rooms even while no one is online.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === 'cleanup-expired') {
    try {
        $database = new Database();
        fwrite(STDOUT, "Expired-room cleanup finished.\n");
        exit(0);
    } catch (Throwable $error) {
        fwrite(STDERR, $error->getMessage() . "\n");
        exit(1);
    }
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        throw new ApiException('errors.api.postRequired', 405);
    }

    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 10000) {
        throw new ApiException('errors.api.payloadTooLarge', 413);
    }

    $request = json_decode(file_get_contents('php://input'), true, 32, JSON_THROW_ON_ERROR);

    if (!is_array($request) || array_is_list($request)) {
        throw new ApiException('errors.api.requestObject');
    }

    $result = (new HamiltonApi(new Database()))->handle($request);

    echo json_encode(['ok' => true] + $result, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    $status = $error instanceof ApiException ? $error->statusCode : 500;
    http_response_code($status);

    echo json_encode([
        'ok' => false,
        'error' => $status === 500 ? 'errors.api.internal' : $error->getMessage()
    ], JSON_UNESCAPED_UNICODE);

    if ($status === 500) {
        error_log((string) $error);
    }
}
