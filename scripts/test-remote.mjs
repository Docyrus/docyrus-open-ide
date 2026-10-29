import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// No existing SSH keys, agent, known_hosts, or Remote Login settings are touched.
const temporary = await mkdtemp(join(tmpdir(), "docyrus-ssh-test-"));
const children = [];
let serverLog = "";
function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${file}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  const root = join(temporary, "project with spaces");
  await mkdir(root);
  await writeFile(join(root, "hello.txt"), "Hello over SFTP!\n");
  await writeFile(join(temporary, "outside.txt"), "must never be read");
  await symlink(temporary, join(root, "escape"));
  const key = join(temporary, "identity");
  const hostKey = join(temporary, "host");
  const wrongKey = join(temporary, "wrong-host");
  for (const path of [key, hostKey, wrongKey]) run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const homes = ["trusted", "unknown", "changed", "revoked"].map(name => join(temporary, name));
  for (const home of homes) await mkdir(join(home, ".ssh"), { recursive: true });
  const hostLine = (await readFile(`${hostKey}.pub`, "utf8")).split(" ").slice(0, 2).join(" ");
  const wrongLine = (await readFile(`${wrongKey}.pub`, "utf8")).split(" ").slice(0, 2).join(" ");
  await writeFile(join(homes[0], ".ssh/known_hosts"), `[127.0.0.1]:${port} ${hostLine}\n`);
  await writeFile(join(homes[1], ".ssh/known_hosts"), "");
  await writeFile(join(homes[2], ".ssh/known_hosts"), `[127.0.0.1]:${port} ${wrongLine}\n`);
  await writeFile(join(homes[3], ".ssh/known_hosts"), `[127.0.0.1]:${port} ${hostLine}\n@revoked * ${hostLine}\n`);
  // Hash the trusted entry too: this is OpenSSH's usual known_hosts format.
  run("/usr/bin/ssh-keygen", ["-q", "-H", "-f", join(homes[0], ".ssh/known_hosts")]);
  const socket = join(temporary, "agent.sock");
  const env = { ...process.env, SSH_AUTH_SOCK: socket };
  const agent = spawn("/usr/bin/ssh-agent", ["-D", "-a", socket], { env, stdio: "ignore" });
  children.push(agent);
  for (let i = 0; i < 50; i++) {
    const ready = spawnSync("/usr/bin/ssh-add", ["-l"], { env, stdio: "ignore" });
    if (ready.status !== 2) break;
    await delay(50);
  }
  run("/usr/bin/ssh-add", [key], env);
  const config = join(temporary, "sshd_config");
  await writeFile(config, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey "${hostKey}"\nPidFile "${temporary}/sshd.pid"\nAuthorizedKeysFile "${key}.pub"\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nAllowUsers ${userInfo().username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\n`);
  const logPath = join(temporary, "sshd.log");
  const server = spawn("/usr/sbin/sshd", ["-D", "-E", logPath, "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(server);
  server.stderr.on("data", data => { serverLog += data; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await new Promise(resolve => {
      const connection = net.connect({ host: "127.0.0.1", port });
      connection.on("connect", () => { connection.destroy(); resolve(true); });
      connection.on("error", () => resolve(false));
    });
    if (ready) break;
    if (server.exitCode !== null) throw new Error(`sshd could not start: ${serverLog}`);
    await delay(50);
  }
  if (!ready) throw new Error(`sshd did not become ready: ${serverLog}`);
  const uri = `sftp://${userInfo().username}@127.0.0.1:${port}${root.split("/").map(encodeURIComponent).join("/")}`;
  const result = spawnSync(resolve("zig-out/bin/remote-integration"), [uri, ...homes], { env, encoding: "utf8", timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${result.error?.message || result.stderr || result.stdout}\nsshd: ${await readFile(logPath, "utf8").catch(() => serverLog)}`);
  process.stdout.write(result.stderr || result.stdout);
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
  await rm(temporary, { recursive: true, force: true });
}
