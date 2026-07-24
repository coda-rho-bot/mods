import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import activate, { __test } from "./mods/index.mjs";

const originalEnv = { ...process.env };

test.afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test("memory candidates prefer scoped MemFS and use a cross-platform home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memfs-search-"));
  const scoped = path.join(root, "scoped-memory");
  await mkdir(scoped);
  delete process.env.MEMORY_DIR;
  delete process.env.HOME;
  process.env.USERPROFILE = root;

  const candidates = __test.candidateMemoryDirs(
    {
      memfs: { memoryDir: scoped },
      agent: { id: "agent-test" },
    },
    { homeDir: root },
  );

  assert.equal(candidates[0].source, "ctx.memfs.memoryDir");
  assert.equal(candidates[0].path, scoped);
  assert.deepEqual(
    candidates.slice(1).map((candidate) => candidate.path),
    [
      path.join(root, ".letta", "lc-local-backend", "memfs", "agent-test", "memory"),
      path.join(root, ".letta", "agents", "agent-test", "memory"),
    ],
  );
  await rm(root, { recursive: true, force: true });
});

test("status reports available fields and every candidate without env values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memfs-search-status-"));
  const memory = path.join(root, "memory");
  await mkdir(memory);
  await writeFile(path.join(memory, "note.md"), "hello");
  delete process.env.MEMORY_DIR;
  delete process.env.AGENT_ID;
  delete process.env.HOME;
  process.env.USERPROFILE = root;

  let registration;
  activate({
    capabilities: { tools: true },
    tools: { register(value) { registration = value; } },
  });
  const output = await registration.run({
    args: { action: "status" },
    agent: { id: "agent-test" },
    memfs: { memoryDir: memory },
  });

  assert.match(output, /ctx\.memfs\.memoryDir: set/);
  assert.match(output, /ctx\.agent\.id: set/);
  assert.match(output, /env\.HOME: not set/);
  assert.match(output, /env\.USERPROFILE: set/);
  assert.match(output, /ctx\.memfs\.memoryDir: .*memory \(exists: yes\)/);
  assert.doesNotMatch(output, new RegExp(`USERPROFILE: ${root}`));
  assert.match(output, /markdown_files: 1/);
  await rm(root, { recursive: true, force: true });
});

test("QMD lookup uses PATH directly and prepends with the platform delimiter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memfs-search-bin-"));
  const executable = path.join(root, "qmd");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);

  const resolved = await __test.resolveExecutable("qmd", {
    platform: process.platform,
    env: { PATH: root },
  });
  assert.equal(resolved, executable);

  const env = __test.qmdEnv(root);
  assert.equal(env.PATH.split(path.delimiter)[0], root);
  await rm(root, { recursive: true, force: true });
});

test("Windows lookup prefers PowerShell shims and never builds a shell string", () => {
  const names = __test.executableNames("qmd", "win32", {
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  });
  assert.ok(names.indexOf("qmd.ps1") < names.indexOf("qmd.cmd"));

  const ps1 = __test.commandInvocation("C:\\bin\\qmd.ps1", ["query", "a&b"], {
    platform: "win32",
  });
  assert.equal(ps1.executable, "powershell.exe");
  assert.deepEqual(ps1.args.slice(-3), ["C:\\bin\\qmd.ps1", "query", "a&b"]);

  const cmd = __test.commandInvocation("C:\\bin\\qmd.cmd", ["query", "a&b"], {
    platform: "win32",
  });
  assert.equal(cmd.executable, "powershell.exe");
  assert.equal(cmd.args.at(-1), "a&b");
  assert.match(cmd.args[cmd.args.indexOf("-Command") + 1], /\$args/);
});
