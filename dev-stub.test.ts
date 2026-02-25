import { datadir, devStubText } from "./dev-stub.ts";

Deno.test("datadir uses expected darwin fallback", () => {
  const actual = datadir("darwin");
  const expected = "${XDG_DATA_HOME:-$HOME/Library/Application Support}";
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
});

Deno.test("devStubText includes dev activation block for /usr/local binaries", () => {
  const text = devStubText("/usr/local/bin/node", "/tmp/pkgs/node/bin", "node", "darwin");
  if (!text.includes("dev_check()")) throw new Error("missing dev_check block");
  if (!text.includes("/usr/local/bin/dev")) throw new Error("missing dev path");
});

Deno.test("devStubText emits direct exec for non-/usr/local paths", () => {
  const text = devStubText("/tmp/local/bin/node", "/tmp/pkgs/node/bin", "node", "linux");
  const expected = 'exec /tmp/pkgs/node/bin/node "$@"';
  if (text !== expected) throw new Error(`expected ${expected}, got ${text}`);
});
