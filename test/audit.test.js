/**
 * The audit sink: append-only JSONL, serialized writes, contained failures.
 *
 * @module @sol-pi-port/dsh-context-compact/test/audit
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AUDIT_SCHEMA, createAuditSink, defaultAuditPath } from "../lib/audit.js";
import { cleanupTempDirs, silentLogger, tempDir } from "./helpers.js";

after(cleanupTempDirs);

describe("audit sink", () => {
	it("appends one schema-tagged JSON line per record, in order, mode 0600", async () => {
		const dir = await tempDir();
		const path = join(dir, "nested", "audit.jsonl");
		const sink = createAuditSink({ path, logger: silentLogger() });
		sink.record({ event: "compaction", status: "committed", n: 1 });
		sink.record({ event: "compaction", status: "failed", n: 2 });
		await sink.flush();
		const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines.length, 2);
		assert.equal(lines[0].schema, AUDIT_SCHEMA);
		assert.equal(lines[0].n, 1);
		assert.equal(lines[1].n, 2);
		assert.match(lines[0].time, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});

	it("serializes concurrent records so no line interleaves", async () => {
		const dir = await tempDir();
		const path = join(dir, "audit.jsonl");
		const sink = createAuditSink({ path, logger: silentLogger() });
		for (let index = 0; index < 32; index += 1) sink.record({ event: "compaction", index });
		await sink.flush();
		const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines.map((line) => line.index), Array.from({ length: 32 }, (_value, index) => index));
	});

	it("contains a write failure with a single warning and never rejects", async () => {
		const dir = await tempDir();
		const blocker = join(dir, "blocker");
		const logger = silentLogger();
		const sink = createAuditSink({ path: join(blocker, "audit.jsonl"), logger });
		/* A regular file where a directory is required makes mkdir fail. */
		const { writeFile } = await import("node:fs/promises");
		await writeFile(blocker, "not a directory\n");
		sink.record({ event: "compaction", status: "committed" });
		sink.record({ event: "compaction", status: "failed" });
		await sink.flush();
		assert.equal(logger.warnings.length, 1, "one-shot warning: auditing must never flood the log");
		assert.match(logger.warnings[0], /audit write failed/);
	});

	it("resolves the default path under the host state root", () => {
		assert.equal(defaultAuditPath("/host"), join("/host", "state", "context-compact", "context-compact-audit.jsonl"));
		assert.equal(defaultAuditPath(), process.env.DSH_HOME === undefined
			? defaultAuditPath(process.env.HOME === undefined ? undefined : join(process.env.HOME, ".dsh"))
			: defaultAuditPath(process.env.DSH_HOME));
	});
});
