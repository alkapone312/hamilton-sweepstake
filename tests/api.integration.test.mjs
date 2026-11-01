import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

async function unusedPort() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function waitForServer(url, processHandle) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (processHandle.exitCode !== null) {
            throw new Error("PHP server exited before becoming ready.");
        }

        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // PHP has not bound the socket yet.
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("PHP server did not start.");
}

test("the API creates exactly one private Hamiltonian cycle", async (t) => {
    const php = spawnSync("php", [
        "-r",
        "echo extension_loaded('pdo_sqlite') ? 'yes' : 'no';"
    ], { encoding: "utf8" });

    if (php.status !== 0 || php.stdout.trim() !== "yes") {
        t.skip("PHP with pdo_sqlite is required for the integration test.");
        return;
    }

    const directory = await mkdtemp(path.join(tmpdir(), "hamilton-test-"));
    const dbFile = path.join(directory, "test.sqlite");
    const port = await unusedPort();
    const url = "http://127.0.0.1:" + port;
    const server = spawn("php", [
        "-S", "127.0.0.1:" + port, "-t", projectDirectory
    ], {
        cwd: projectDirectory,
        env: {
            ...process.env,
            DB_FILE: dbFile,
            HAMILTON_DB_TABLE_PREFIX: "test_hamilton_"
        },
        stdio: "ignore"
    });

    t.after(async () => {
        server.kill("SIGTERM");
        await new Promise((resolve) => {
            if (server.exitCode !== null) {
                resolve();
            } else {
                server.once("exit", resolve);
            }
        });
        await rm(directory, { recursive: true, force: true });
    });

    await waitForServer(url, server);

    async function request(action, data = {}) {
        const response = await fetch(url + "/api.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...data })
        });

        return { status: response.status, body: await response.json() };
    }

    // A test-only database inspector, never connected to the production DB.
    function sql(statement, values = []) {
        const script = [
            '$pdo = new PDO("sqlite:" . getenv("DB_FILE"));',
            '$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);',
            '$pdo->exec("PRAGMA foreign_keys = ON");',
            '$stmt = $pdo->prepare($argv[1]);',
            '$stmt->execute(json_decode($argv[2], true, 16, JSON_THROW_ON_ERROR));',
            'echo json_encode($stmt->fetch(PDO::FETCH_ASSOC) ?: [], JSON_THROW_ON_ERROR);'
        ].join(" ");

        const result = spawnSync(
            "php", ["-r", script, "--", statement, JSON.stringify(values)],
            {
                encoding: "utf8",
                env: { ...process.env, DB_FILE: dbFile }
            }
        );

        assert.equal(result.status, 0, result.stderr);

        return JSON.parse(result.stdout);
    }

    const create = await request("create_room", { name: "Our cycle" });
    assert.equal(create.status, 200);
    assert.equal(create.body.ok, true);
    assert.equal(create.body.room.status, "waiting");
    assert.equal(create.body.room.participantCount, 0);

    const { roomId, ownerToken } = create.body;
    const noPeople = await request("draw_room", { roomId, ownerToken });
    assert.equal(noPeople.status, 409);
    assert.equal(noPeople.body.error, "errors.api.notEnoughPeople");

    const names = ["Ada", "Bolek", "Celina", "Darek", "Ela"];
    const tokens = new Map();

    for (const username of names) {
        const joined = await request("join_room", { roomId, username });
        assert.equal(joined.status, 200);
        assert.equal(joined.body.username, username);
        tokens.set(username, joined.body.participantToken);
    }

    const duplicate = await request("join_room", { roomId, username: "ada" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "errors.api.usernameTaken");

    const publicBefore = await request("get_room", { roomId });
    assert.equal(publicBefore.status, 200);
    assert.deepEqual(publicBefore.body.room.participants, names);
    assert.equal(publicBefore.body.room.status, "waiting");
    assert.ok(!JSON.stringify(publicBefore.body).includes("assignedName"));
    assert.ok(!JSON.stringify(publicBefore.body).includes("token"));

    const notOwner = await request("draw_room", {
        roomId, ownerToken: tokens.get("Ada")
    });
    assert.equal(notOwner.status, 403);

    const pending = await request("my_result", {
        roomId,
        participantToken: tokens.get("Ada")
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.assignedName, null);

    const drawn = await request("draw_room", { roomId, ownerToken });
    assert.equal(drawn.status, 200);
    assert.deepEqual(drawn.body, { ok: true, drawn: true, participantCount: names.length });
    assert.equal(JSON.stringify(drawn.body).includes("next"), false);

    const withoutToken = await request("my_result", { roomId });
    assert.equal(withoutToken.status, 403);

    const lateJoin = await request("join_room", { roomId, username: "Franek" });
    assert.equal(lateJoin.status, 409);

    const publicAfterDraw = await request("get_room", { roomId });
    assert.equal(publicAfterDraw.body.room.status, "drawn");
    assert.deepEqual(publicAfterDraw.body.room.participants, names);
    assert.ok(!JSON.stringify(publicAfterDraw.body).includes("assignedName"));

    const assignments = new Map();

    for (let index = 0; index < names.length; index++) {
        const username = names[index];
        const result = await request("my_result", {
            roomId,
            participantToken: tokens.get(username)
        });

        assert.equal(result.status, 200);
        assert.equal(result.body.username, username);
        assert.notEqual(result.body.assignedName, username);
        assert.ok(names.includes(result.body.assignedName));
        assert.deepEqual(Object.keys(result.body).sort(), ["assignedName", "ok", "username"]);
        assignments.set(username, result.body.assignedName);

        if (index === 0) {
            // A second read with the same token must not count as a new person.
            const repeat = await request("my_result", {
                roomId,
                participantToken: tokens.get(username)
            });
            assert.equal(repeat.status, 200);
            assert.deepEqual(repeat.body, result.body);
        }

        if (index < names.length - 1) {
            const room = await request("get_room", { roomId });
            assert.equal(room.status, 200, "Room must survive while someone has not read.");
        }
    }

    assert.equal(new Set(assignments.values()).size, names.length);

    // A collection of disjoint cycles would not pass this check.
    let current = names[0];
    const visited = new Set();

    for (let i = 0; i < names.length; i++) {
        assert.ok(!visited.has(current), "Cycle repeated a node too early.");
        visited.add(current);
        current = assignments.get(current);
    }

    assert.equal(current, names[0]);
    assert.equal(visited.size, names.length);

    // The last successful retrieval atomically deletes the room and its people.
    const publicAfter = await request("get_room", { roomId });
    assert.equal(publicAfter.status, 404);
    assert.equal(publicAfter.body.error, "errors.api.roomNotFound");

    const reopen = await request("my_result", {
        roomId,
        participantToken: tokens.get("Ada")
    });
    assert.equal(reopen.status, 404);

    const joinDeleted = await request("join_room", { roomId, username: "Franek" });
    assert.equal(joinDeleted.status, 404);

    const redraw = await request("draw_room", { roomId, ownerToken });
    assert.equal(redraw.status, 404);

    const other = await request("create_room", { name: "Another room" });
    const crossRoom = await request("my_result", {
        roomId: other.body.roomId,
        participantToken: tokens.get("Ada")
    });
    assert.equal(crossRoom.status, 403);

    // Only an authenticated room owner can see the expiration timestamp.
    const publicRoom = await request("get_room", { roomId: other.body.roomId });
    assert.equal(publicRoom.status, 200);
    assert.equal("expiresAt" in publicRoom.body.room, false);
    assert.equal("serverTime" in publicRoom.body.room, false);

    const invalidOwner = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: tokens.get("Ada")
    });
    assert.equal("expiresAt" in invalidOwner.body.room, false);

    const ownerView = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: other.body.ownerToken
    });
    assert.equal(ownerView.status, 200);
    assert.ok(Number.isInteger(ownerView.body.room.expiresAt));
    assert.ok(Number.isInteger(ownerView.body.room.serverTime));
    assert.ok(ownerView.body.room.expiresAt - ownerView.body.room.serverTime > 3500);
    assert.ok(ownerView.body.room.expiresAt - ownerView.body.room.serverTime <= 3600);

    // Simulate a nearly expired room without waiting 60 minutes.
    const almostExpired = Math.floor(Date.now() / 1000) + 30;
    sql(
        "UPDATE test_hamilton_rooms SET expires_at = ? WHERE id = ?",
        [almostExpired, other.body.roomId]
    );

    const beforeJoin = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: other.body.ownerToken
    });
    assert.equal(beforeJoin.body.room.expiresAt, almostExpired);

    // Polling and rejected registrations must not renew the room.
    await request("get_room", { roomId: other.body.roomId });
    const stillBeforeJoin = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: other.body.ownerToken
    });
    assert.equal(stillBeforeJoin.body.room.expiresAt, almostExpired);

    const joined = await request("join_room", {
        roomId: other.body.roomId,
        username: "First"
    });
    assert.equal(joined.status, 200);

    const renewed = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: other.body.ownerToken
    });
    assert.ok(renewed.body.room.expiresAt > almostExpired + 3500);
    assert.ok(renewed.body.room.expiresAt - renewed.body.room.serverTime <= 3600);

    const duplicateAfterJoin = await request("join_room", {
        roomId: other.body.roomId,
        username: "first"
    });
    assert.equal(duplicateAfterJoin.status, 409);
    const renewedAfterDuplicate = await request("get_room", {
        roomId: other.body.roomId,
        ownerToken: other.body.ownerToken
    });
    assert.equal(renewedAfterDuplicate.body.room.expiresAt, renewed.body.room.expiresAt);

    // Expiry removes rooms and their participant records (ON DELETE CASCADE).
    sql(
        "UPDATE test_hamilton_rooms SET expires_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000) - 1, other.body.roomId]
    );
    const expired = await request("get_room", { roomId: other.body.roomId });
    assert.equal(expired.status, 404);
    assert.equal(expired.body.error, "errors.api.roomNotFound");
    const tooLate = await request("join_room", {
        roomId: other.body.roomId,
        username: "Too Late"
    });
    assert.equal(tooLate.status, 404);
    assert.equal(
        Number(sql(
            "SELECT COUNT(*) AS total FROM test_hamilton_participants WHERE room_id = ?",
            [other.body.roomId]
        ).total),
        0
    );
    assert.equal(
        Number(sql(
            "SELECT COUNT(*) AS total FROM test_hamilton_rooms WHERE id = ?",
            [other.body.roomId]
        ).total),
        0
    );

    // Cron can clean an abandoned room even without browser activity.
    const abandoned = await request("create_room", { name: "Abandoned" });
    sql(
        "UPDATE test_hamilton_rooms SET expires_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000) - 1, abandoned.body.roomId]
    );
    const cleanup = spawnSync("php", ["api.php", "cleanup-expired"], {
        cwd: projectDirectory,
        encoding: "utf8",
        env: {
            ...process.env,
            DB_FILE: dbFile,
            HAMILTON_DB_TABLE_PREFIX: "test_hamilton_"
        }
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(
        Number(sql(
            "SELECT COUNT(*) AS total FROM test_hamilton_rooms WHERE id = ?",
            [abandoned.body.roomId]
        ).total),
        0
    );

    // A drawn room also expires when someone has not retrieved their result.
    const unread = await request("create_room", { name: "Unclaimed results" });
    for (const username of ["One", "Two"]) {
        assert.equal((await request("join_room", {
            roomId: unread.body.roomId,
            username
        })).status, 200);
    }
    assert.equal((await request("draw_room", {
        roomId: unread.body.roomId,
        ownerToken: unread.body.ownerToken
    })).status, 200);

    sql(
        "UPDATE test_hamilton_rooms SET expires_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000) - 1, unread.body.roomId]
    );
    const expiredDraw = await request("get_room", { roomId: unread.body.roomId });
    assert.equal(expiredDraw.status, 404);
});
