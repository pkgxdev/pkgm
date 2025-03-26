#!/usr/bin/env -S pkgx --quiet deno^2.1 run --ext=ts --allow-sys=uid --allow-run --allow-env --allow-read --allow-write --allow-ffi --allow-net=dist.pkgx.dev
import {
  hooks,
  Installation,
  Path,
  plumbing,
  SemVer,
  semver,
  utils,
} from "https://deno.land/x/libpkgx@v0.20.3/mod.ts";
import { dirname, join } from "jsr:@std/path@^1";
import { ensureDir, existsSync, walk } from "jsr:@std/fs@^1";
import { parseArgs } from "jsr:@std/cli@^1";
import hydrate from "https://deno.land/x/libpkgx@v0.20.3/src/plumbing/hydrate.ts";

function standardPath() {
  let path = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  // for pkgx installed via homebrew
  let homebrewPrefix = "";
  switch (Deno.build.os) {
    case "darwin":
      homebrewPrefix = "/opt/homebrew"; // /usr/local is already in the path
      break;
    case "linux":
      homebrewPrefix = `/home/linuxbrew/.linuxbrew:${
        Deno.env.get("HOME")
      }/.linuxbrew`;
      break;
  }
  if (homebrewPrefix) {
    homebrewPrefix = Deno.env.get("HOMEBREW_PREFIX") ?? homebrewPrefix;
    path = `${homebrewPrefix}/bin:${path}`;
  }

  return path;
}

const parsedArgs = parseArgs(Deno.args, {
  alias: {
    v: "version",
    h: "help",
    p: "pin",
  },
  boolean: ["help", "version", "pin"],
});

if (parsedArgs.help || parsedArgs._[0] == "help") {
  const { code } = await new Deno.Command("pkgx", {
    args: [
      "glow",
      "https://raw.githubusercontent.com/pkgxdev/pkgm/refs/heads/main/README.md",
    ],
  }).spawn().status;
  Deno.exit(code);
} else if (parsedArgs.version) {
  console.log("pkgm 0.0.0+dev");
} else {
  const args = parsedArgs._.map((x) => `${x}`).slice(1);

  switch (parsedArgs._[0]) {
    case "install":
    case "i":
      {
        const rv = await install(args, install_prefix().string);
        console.log(rv.join("\n"));
      }
      break;
    case "local-install":
    case "li":
      if (install_prefix().string != "/usr/local") {
        await install(args, Path.home().join(".local").string);
      } else {
        console.error("deprecated: use `pkgm install` without `sudo` instead");
      }
      break;
    case "stub":
    case "shim":
      // equivalent to `pkgx^1 install`
      // shims often work just fine, but sometimes don’t.
      // when they don’t it is usually because the consuming tool makes assumptions about
      // where files for the package in question reside.
      await shim(args, install_prefix().string);
      break;
    case "uninstall":
    case "rm":
      {
        let all_success = true;
        for (const arg of args) {
          if (!await uninstall(arg)) {
            all_success = false;
          }
        }
        Deno.exit(all_success ? 0 : 1);
      }
      break;
    case "list":
    case "ls":
      for await (const path of ls()) {
        console.log(path);
      }
      break;
    case "up":
    case "update":
    case "upgrade":
      await update();
      break;

    case "pin":
      console.error("%cU EARLY! soz, not implemented", "color:red");
      Deno.exit(1);
      break;
    case "outdated":
      await outdated();
      break;
    default:
      if (Deno.args.length === 0) {
        console.error("https://github.com/pkgxdev/pkgm");
      } else {
        console.error("invalid usage");
      }
      Deno.exit(2);
  }
}

async function install(args: string[], basePath: string) {
  if (args.length === 0) {
    console.error("no packages specified");
    Deno.exit(1);
  }

  const pkgx = get_pkgx();

  const [json] = await query_pkgx(pkgx, args);
  const pkg_prefixes = json.pkgs.map((x) =>
    `${x.pkg.project}/v${x.pkg.version}`
  );

  const pkgx_dir = Deno.env.get("PKGX_DIR") || `${Deno.env.get("HOME")}/.pkgx`;

  const runtime_env = expand_runtime_env(json, basePath);

  const dst = basePath;
  for (const pkg_prefix of pkg_prefixes) {
    // create ${dst}/pkgs/${prefix}
    await mirror_directory(join(dst, "pkgs"), pkgx_dir, pkg_prefix);
    // symlink ${dst}/pkgs/${prefix} to ${dst}
    if (!pkg_prefix.startsWith("pkgx.sh/v")) {
      // ^^ don’t overwrite ourselves
      // ^^ * https://github.com/pkgxdev/pkgm/issues/14
      // ^^ * https://github.com/pkgxdev/pkgm/issues/17
      await symlink(join(dst, "pkgs", pkg_prefix), dst);
    }
    // create v1, etc. symlinks
    await create_v_symlinks(join(dst, "pkgs", pkg_prefix));
  }

  const rv = [];

  for (const [project, env] of Object.entries(runtime_env)) {
    if (project == "pkgx.sh") continue;

    const pkg_prefix = pkg_prefixes.find((x) => x.startsWith(project))!;

    if (!pkg_prefix) continue; //FIXME wtf?

    for (const bin of ["bin", "sbin"]) {
      const bin_prefix = join(`${dst}/pkgs`, pkg_prefix, bin);

      if (!existsSync(bin_prefix)) continue;

      for await (const entry of Deno.readDir(bin_prefix)) {
        if (!entry.isFile) continue;

        const to_stub = join(dst, bin, entry.name);

        let sh = `#!/bin/sh\n`;
        for (const [key, value] of Object.entries(env)) {
          sh += `export ${key}="${value}"\n`;
        }
        sh += `exec "${bin_prefix}/${entry.name}" "$@"\n`;

        await Deno.remove(to_stub); //FIXME inefficient to symlink for no reason
        await Deno.writeTextFile(to_stub, sh);
        await Deno.chmod(to_stub, 0o755);

        rv.push(to_stub);
      }
    }
  }

  if (!Deno.env.get("PATH")?.split(":")?.includes(basePath)) {
    console.error("%c! warning:", "color:yellow", `${basePath} not in $PATH`);
  }

  return rv;
}

async function shim(args: string[], basePath: string) {
  const pkgx = get_pkgx();

  await ensureDir(join(basePath, "bin"));

  const json = (await query_pkgx(pkgx, args))[0];

  for (const pkg of json.pkgs) {
    for (const bin of ["bin", "sbin"]) {
      const bin_prefix = pkg.path.join(bin);
      if (!bin_prefix.exists()) continue;
      for await (const entry of Deno.readDir(bin_prefix.string)) {
        if (!entry.isFile && !entry.isSymlink) continue;
        const name = entry.name;
        const quick_shim = Deno.build.os == "darwin" &&
          pkgx == "/usr/local/bin/pkgx";
        const interpreter = quick_shim
          ? "/usr/local/bin/pkgx"
          : "/usr/bin/env -S pkgx";

        const shim =
          `#!${interpreter} --shebang --quiet +${pkg.pkg.project}=${pkg.pkg.version} -- ${name}`;

        if (existsSync(join(basePath, "bin", name))) {
          await Deno.remove(join(basePath, "bin", name));
        }

        // without the newline zsh on macOS fails to invoke the interpreter with a bad interpreter error
        await Deno.writeTextFile(join(basePath, "bin", name), shim + "\n", {
          mode: 0o755,
        });

        console.error(join(basePath, "bin", name));
      }
    }
  }
}

interface JsonResponse {
  runtime_env: Record<string, Record<string, string>>;
  pkgs: Installation[];
  env: Record<string, Record<string, string>>;
  pkg: Installation;
}

async function query_pkgx(
  pkgx: string,
  args: string[],
): Promise<[JsonResponse, Record<string, string>]> {
  args = args.map((x) => `+${x}`);

  const env: Record<string, string> = {
    "PATH": standardPath(),
  };
  const set = (key: string) => {
    const x = Deno.env.get(key);
    if (x) env[key] = x;
  };
  set("HOME");
  set("PKGX_DIR");
  set("PKGX_PANTRY_DIR");
  set("PKGX_DIST_URL");

  const needs_sudo_backwards = install_prefix().string == "/usr/local";
  let cmd = needs_sudo_backwards ? "/usr/bin/sudo" : pkgx;
  if (needs_sudo_backwards) {
    if (!Deno.env.get("SUDO_USER")) {
      if (Deno.uid() == 0) {
        console.error(
          "%cwarning",
          "color:yellow",
          "installing as root; installing via `sudo` is preferred",
        );
      }
      cmd = pkgx;
    } else {
      args.unshift("-u", Deno.env.get("SUDO_USER")!, pkgx);
    }
  }

  const proc = new Deno.Command(cmd, {
    args: [...args, "--json=v1"],
    stdout: "piped",
    env,
    clearEnv: true,
  })
    .spawn();

  const status = await proc.status;

  if (!status.success) {
    Deno.exit(status.code);
  }

  const out = await proc.output();
  const json = JSON.parse(new TextDecoder().decode(out.stdout));
  const pkgs =
    (json.pkgs as { path: string; project: string; version: string }[]).map(
      (x) => {
        return {
          path: new Path(x.path),
          pkg: { project: x.project, version: new SemVer(x.version) },
        };
      },
    );
  const pkg = pkgs.find((x) => `+${x.pkg.project}` == args[0])!;
  return [{
    pkg,
    pkgs,
    env: json.env,
    runtime_env: json.runtime_env,
  }, env];
}

async function mirror_directory(dst: string, src: string, prefix: string) {
  await processEntry(join(src, prefix), join(dst, prefix));

  async function processEntry(sourcePath: string, targetPath: string) {
    const fileInfo = await Deno.lstat(sourcePath);

    if (fileInfo.isDirectory) {
      // Create the target directory
      await ensureDir(targetPath);

      // Recursively process the contents of the directory
      for await (const entry of Deno.readDir(sourcePath)) {
        const entrySourcePath = join(sourcePath, entry.name);
        const entryTargetPath = join(targetPath, entry.name);
        await processEntry(entrySourcePath, entryTargetPath);
      }
    } else if (fileInfo.isFile) {
      // Remove the target file if it exists
      if (existsSync(targetPath)) {
        await Deno.remove(targetPath);
      }
      // Create a hard link for files
      await Deno.link(sourcePath, targetPath);
    } else if (fileInfo.isSymlink) {
      // Recreate symlink in the target directory
      const linkTarget = await Deno.readLink(sourcePath);
      symlink_with_overwrite(linkTarget, targetPath);
    } else {
      throw new Error(`unsupported file type at: ${sourcePath}`);
    }
  }
}

async function symlink(src: string, dst: string) {
  for (
    const base of [
      "bin",
      "sbin",
      "share",
      "lib",
      "libexec",
      "var",
      "etc",
      "ssl", // FIXME for ca-certs
    ]
  ) {
    const foo = join(src, base);
    if (existsSync(foo)) {
      await processEntry(foo, join(dst, base));
    }
  }

  async function processEntry(sourcePath: string, targetPath: string) {
    const fileInfo = await Deno.lstat(sourcePath);

    if (fileInfo.isDirectory) {
      // Create the target directory
      await ensureDir(targetPath);

      // Recursively process the contents of the directory
      for await (const entry of Deno.readDir(sourcePath)) {
        const entrySourcePath = join(sourcePath, entry.name);
        const entryTargetPath = join(targetPath, entry.name);
        await processEntry(entrySourcePath, entryTargetPath);
      }
    } else {
      // resinstall
      if (existsSync(targetPath)) {
        await Deno.remove(targetPath);
      }
      symlink_with_overwrite(sourcePath, targetPath);
    }
  }
}

//FIXME we only do major as that's typically all pkgs need, but like we should do better
async function create_v_symlinks(prefix: string) {
  const shelf = dirname(prefix);

  const versions = [];
  for await (const { name, isDirectory, isSymlink } of Deno.readDir(shelf)) {
    if (isSymlink) continue;
    if (!isDirectory) continue;
    if (!name.startsWith("v")) continue;
    if (name == "var") continue;
    const version = semver.parse(name);
    if (version) {
      versions.push(version);
    }
  }

  // collect an Record of versions per major version
  const major_versions: Record<number, SemVer> = {};
  for (const version of versions) {
    if (
      major_versions[version.major] === undefined ||
      version.gt(major_versions[version.major])
    ) {
      major_versions[version.major] = version;
    }
  }

  for (const [key, semver] of Object.entries(major_versions)) {
    symlink_with_overwrite(`v${semver}`, join(shelf, `v${key}`));
  }
}

function expand_runtime_env(
  json: JsonResponse,
  basePath: string,
) {
  const { runtime_env, pkgs } = json;

  //FIXME this combines all runtime env which is strictly overkill
  // for transitive deps that may not need it

  const expanded: Record<string, Set<string>> = {};
  for (const [_project, env] of Object.entries(runtime_env)) {
    for (const [key, value] of Object.entries(env)) {
      const pkg = pkgs.find((x) => x.pkg.project == _project)!.pkg;
      const mm = hooks.useMoustaches().tokenize.all(pkg, json.pkgs);
      const new_value = hooks.useMoustaches().apply(value, mm);
      expanded[key] ??= new Set<string>();
      expanded[key].add(new_value);
    }
  }

  // fix https://github.com/pkgxdev/pkgm/pull/30#issuecomment-2678957666
  if (Deno.build.os == "linux") {
    expanded["LD_LIBRARY_PATH"] ??= new Set<string>();
    expanded["LD_LIBRARY_PATH"].add(`${basePath}/lib`);
  }

  const rv: Record<string, string> = {};
  for (const [key, set] of Object.entries(expanded)) {
    rv[key] = [...set].join(":");
  }

  // DUMB but easiest way to fix a bug
  const rv2: Record<string, Record<string, string>> = {};
  for (const { pkg: { project } } of json.pkgs) {
    rv2[project] = rv;
  }

  return rv2;
}

function symlink_with_overwrite(src: string, dst: string) {
  if (existsSync(dst)) {
    Deno.removeSync(dst);
  }
  Deno.symlinkSync(src, dst);
}

function get_pkgx() {
  for (const path of Deno.env.get("PATH")!.split(":")) {
    const pkgx = join(path, "pkgx");
    if (existsSync(pkgx)) {
      const out = new Deno.Command(pkgx, { args: ["--version"] }).outputSync();
      const match = new TextDecoder().decode(out.stdout).match(/pkgx 2.(\d+)/);
      if (!match || parseInt(match[1]) < 4) {
        console.error("pkgm requires pkgx 2.4.0 or later");
        Deno.exit(1);
      }
      return pkgx;
    }
  }
  throw new Error("no `pkgx` found in `$PATH`");
}

async function* ls() {
  for (
    const path of [new Path("/usr/local/pkgs"), Path.home().join(".local/pkgs")]
  ) {
    if (!path.isDirectory()) continue;
    const dirs = [path];
    let dir: Path | undefined;
    while ((dir = dirs.pop()) != undefined) {
      for await (const [path, { name, isDirectory, isSymlink }] of dir.ls()) {
        if (!isDirectory || isSymlink) continue;
        if (/^v\d+\./.test(name)) {
          yield path;
        } else {
          dirs.push(path);
        }
      }
    }
  }
}

async function uninstall(arg: string) {
  let found: { project: string } | undefined =
    (await hooks.usePantry().find(arg))?.[0];
  if (!found) {
    found = await plumbing.which(arg);
  }
  if (!found) {
    console.error(`no such pkg: ${arg}`);
    return false;
  }

  const set = new Set<string>();
  const files: Path[] = [];
  let dirs: Path[] = [];
  const pkg_dirs: Path[] = [];
  const root = install_prefix();
  const dir = root.join("pkgs", found.project);
  if (!dir.isDirectory()) {
    console.error(`not installed: ${dir}`);
    if (
      root.string == "/usr/local" &&
      Path.home().join(".local/pkgs", found.project).isDirectory()
    ) {
      console.error(
        `%c! rerun without \`sudo\` to uninstall ~/.local/pkgs/${found.project}`,
        "color:yellow",
      );
    } else if (new Path("/usr/local/pkgs").join(found.project).isDirectory()) {
      console.error(
        `%c! rerun as \`sudo\` to uninstall /usr/local/pkgs/${found.project}`,
        "color:yellow",
      );
    }
    return false;
  }

  console.error("%cuninstalling", "color:red", dir);

  pkg_dirs.push(dir);
  for await (const [pkgdir, { isDirectory }] of dir.ls()) {
    if (!isDirectory) continue;
    for await (const { path, isDirectory } of walk(pkgdir.string)) {
      const leaf = new Path(path).relative({ to: pkgdir });
      const resolved_path = root.join(leaf);
      if (set.has(resolved_path.string)) continue;
      if (!resolved_path.exists()) continue;
      if (isDirectory) {
        dirs.push(resolved_path);
      } else {
        files.push(resolved_path);
      }
    }
  }

  // we need to delete this in a heirachical fashion or they don’t delete
  dirs = dirs.sort().reverse();

  if (files.length == 0) {
    console.error("unexpectedly not installed");
    Deno.exit(1);
  }
  for (const path of files) {
    if (!path.isDirectory()) {
      Deno.removeSync(path.string);
    }
  }
  for (const path of dirs) {
    if (path.isDirectory()) {
      try {
        Deno.removeSync(path.string);
      } catch {
        // some dirs will not be removable
      }
    }
  }
  for (const path of pkg_dirs) {
    Deno.removeSync(path.string, { recursive: true });
  }

  return true;
}

function writable(path: string) {
  try {
    //FIXME this is pretty gross
    Deno.mkdirSync(join(path, ".writable_test"), { recursive: true });
    Deno.remove(join(path, ".writable_test"));
    return true;
  } catch {
    return false;
  }
}

async function outdated() {
  const pkgs: Installation[] = [];
  for await (const pkg of walk_pkgs(new Path("/usr/local/pkgs"))) {
    pkgs.push(pkg);
  }
  for await (const pkg of walk_pkgs(Path.home().join(".local/pkgs"))) {
    pkgs.push(pkg);
  }

  const { pkgs: raw_graph } = await hydrate(
    pkgs.map((x) => ({
      project: x.pkg.project,
      constraint: new semver.Range(`^${x.pkg.version}`),
    })),
  );
  const graph: Record<string, semver.Range> = {};
  for (const { project, constraint } of raw_graph) {
    graph[project] = constraint;
  }

  for (const { path, pkg } of pkgs) {
    const versions = await hooks.useInventory().get(pkg);
    // console.log(pkg, graph[pkg.project]);
    const constrained_versions = versions.filter((x) =>
      graph[pkg.project].satisfies(x) && x.gt(pkg.version)
    );
    if (constrained_versions.length) {
      console.log(
        pkg.project,
        "is outdated",
        pkg.version,
        "<",
        constrained_versions.slice(-1)[0],
        `\x1b[2m${path}\x1b[22m`,
      );
    }
  }
}

async function* walk_pkgs(root: Path) {
  const dirs = [root];
  let dir: Path | undefined;
  while ((dir = dirs.pop()) !== undefined) {
    if (!dir.isDirectory()) continue;
    for await (const [path, { name, isSymlink, isDirectory }] of dir.ls()) {
      if (isSymlink || !isDirectory) continue;
      if (semver.parse(name)) {
        const project = path.parent().relative({ to: root });
        const version = new SemVer(path.basename());
        yield { path, pkg: { project, version } };
      } else {
        dirs.push(path);
      }
    }
  }
}

async function update() {
  const pkgs: Installation[] = [];
  for await (const pkg of walk_pkgs(install_prefix().join("pkgs"))) {
    pkgs.push(pkg);
  }

  const { pkgs: raw_graph } = await hydrate(
    pkgs.map((x) => ({
      project: x.pkg.project,
      constraint: new semver.Range(`^${x.pkg.version}`),
    })),
  );
  const graph: Record<string, semver.Range> = {};
  for (const { project, constraint } of raw_graph) {
    graph[project] = constraint;
  }

  const update_list = [];

  for (const { pkg } of pkgs) {
    const versions = await hooks.useInventory().get(pkg);
    const constrained_versions = versions.filter((x) =>
      graph[pkg.project].satisfies(x) && x.gt(pkg.version)
    );

    if (constrained_versions.length) {
      const pkgspec = `${pkg.project}=${constrained_versions.slice(-1)[0]}`;
      update_list.push(pkgspec);
    }
  }

  for (const pkgspec of update_list) {
    const pkg = utils.pkg.parse(pkgspec);
    console.log(
      "updating:",
      new Path("/usr/local/pkgs").join(pkg.project),
      "to",
      pkg.constraint.single(),
    );
  }

  await install(update_list, install_prefix().string);
}

function install_prefix() {
  // if /usr/local is writable, use that
  if (writable("/usr/local")) {
    return new Path("/usr/local");
  } else {
    return Path.home().join(".local");
  }
}
