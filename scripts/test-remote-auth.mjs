import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;
const temporary = await mkdtemp(join(tmpdir(), "docyrus-auth-test-"));
const home = join(temporary, "trusted");
const untrusted = join(temporary, "unknown");
const hostKey = utils.generateKeyPairSync("ed25519");
const servers = [];
const clients = new Set();
const content = Buffer.from("Authenticated SFTP\n");
const directory = { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
const file = { ...directory, mode: 0o100644, size: content.length };

const openedDirectories = [];
const entries = new Map([
  ["/project", ["hello.txt", "folder", "unopened"]],
  ["/project/folder", ["inner.txt", "deeper"]],
  ["/project/folder/deeper", ["leaf.txt"]],
  ["/project/unopened", ["never-read.txt"]],
]);

function serveFiles(client, delay = 0) {
  client.on("session", accept => {
    accept().on("sftp", accept => {
      const stream = accept();
      stream.on("error", () => {});
      const handles = new Map();
      let sequence = 0;
      const handle = (id, state) => {
        const key = Buffer.alloc(4);
        key.writeUInt32BE(++sequence);
        handles.set(sequence, state);
        stream.handle(id, key);
      };
      const state = key => key.length === 4 ? handles.get(key.readUInt32BE()) : null;
      stream.on("REALPATH", id => stream.name(id, [{ filename: "/project", longname: "/project", attrs: directory }]));
      stream.on("LSTAT", (id, path) => {
        if (entries.has(path)) stream.attrs(id, directory);
        else if (path.endsWith(".txt")) stream.attrs(id, file);
        else stream.status(id, STATUS_CODE.NO_SUCH_FILE);
      });
      stream.on("OPENDIR", (id, path) => {
        openedDirectories.push(path);
        if (process.argv.includes("--serve")) console.log(`directory: ${path}`);
        if (entries.has(path)) handle(id, { directory: true, path, read: false });
        else stream.status(id, STATUS_CODE.NO_SUCH_FILE);
      });
      stream.on("READDIR", (id, key) => {
        const entry = state(key);
        if (!entry?.directory || entry.read) return stream.status(id, STATUS_CODE.EOF);
        entry.read = true;
        const send = () => {
          if (stream.destroyed) return;
          stream.name(id, entries.get(entry.path).map(filename => ({ filename, longname: filename, attrs: entries.has(`${entry.path}/${filename}`) ? directory : file })));
        };
        if (delay) setTimeout(send, delay);
        else send();
      });
      stream.on("OPEN", (id, path) => path.endsWith(".txt") ? handle(id, { directory: false }) : stream.status(id, STATUS_CODE.NO_SUCH_FILE));
      stream.on("READ", (id, key, offset, length) => {
        if (!state(key) || offset >= content.length) return stream.status(id, STATUS_CODE.EOF);
        stream.data(id, content.subarray(offset, offset + length));
      });
      stream.on("CLOSE", (id, key) => {
        if (key.length === 4) handles.delete(key.readUInt32BE());
        stream.status(id, STATUS_CODE.OK);
      });
    });
  });
}

async function startServer(method, delay = 0) {
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", context => {
      if (context.username !== "test-user" || context.method !== method) return context.reject([method]);
      if (method === "password") return context.password === "sftp-test-pässword" ? context.accept() : context.reject([method]);
      context.prompt([{ prompt: "Password", echo: false }], "SSH authentication", "Enter your password", answers => {
        if (answers[0] !== "sftp-test-pässword") return context.reject([method]);
        context.prompt([{ prompt: "Verification code", echo: false }], "SSH authentication", "Enter your verification code", answers => {
          if (answers[0] === "654321") context.accept();
          else context.reject([method]);
        });
      });
    });
    client.on("ready", () => serveFiles(client, delay));
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function runClient(uri, method) {
  await new Promise((resolveResult, reject) => {
    const child = spawn(resolve("zig-out/bin/remote-integration"), ["--auth", uri, home, untrusted, method], {
      env: { ...process.env, SSH_AUTH_SOCK: join(temporary, "no-agent.sock") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) { process.stdout.write(output); resolveResult(); }
      else reject(new Error(output || "Authentication integration client failed"));
    });
  });
}

try {
  for (const path of [home, untrusted]) await mkdir(join(path, ".ssh"), { recursive: true });
  await writeFile(join(untrusted, ".ssh/known_hosts"), "");
  const passwordPort = await startServer("password", process.argv.includes("--slow") ? 5000 : 0);
  const interactivePort = await startServer("keyboard-interactive");
  const deadlinePort = await startServer("password", 2000);
  const key = hostKey.public.trim().split(" ").slice(0, 2).join(" ");
  await writeFile(join(home, ".ssh/known_hosts"), [passwordPort, interactivePort, deadlinePort].map(port => `[127.0.0.1]:${port} ${key}\n`).join(""));
  const uri = port => `sftp://test-user@127.0.0.1:${port}/project`;
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ home, password: uri(passwordPort), interactive: uri(interactivePort) }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    await runClient(uri(passwordPort), "password");
    await runClient(uri(interactivePort), "keyboard-interactive");
    await runClient(uri(deadlinePort), "deadline");
    if (openedDirectories.some(path => path === "/project/unopened" || path === "/project/folder/deeper")) throw new Error("Directory browsing recursively opened an unrequested folder");
  }
} finally {
  for (const client of clients) client.end();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await rm(temporary, { recursive: true, force: true });
}
