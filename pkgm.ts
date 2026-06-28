#!/usr/bin/env -S pkgx --quiet deno^2.1 run --ext=ts --allow-sys=uid --allow-run --allow-env --allow-read --allow-write --allow-ffi --allow-net=dist.pkgx.dev
import {
  hooks,
  Installation,
  Path,
  plumbing,
  SemVer,
  semver,
  utils,
} from "https://deno.land/x/libpkgx@v0.21.0/mod.ts";
import { dirname, join } from "jsr:@std/path@^1";
import { ensureDir, existsSync, walk } from "jsr:@std/fs@^1";
import { parseArgs } from "jsr:@std/cli@^1";
import { parse as parse_toml } from "jsr:@std/toml@^1";
const { hydrate } = plumbing;

// declared up here (not beside the other manifest helpers) because the
// top-level command dispatch below runs during module evaluation and can call
// record_install → apply_manifest before a `const` placed lower would be
// initialized (temporal dead zone).
const MANIFEST_HEADER =
  `# pkgm manifest — the packages you’ve asked pkgm to manage.
#
# key = a package; value = either:
#   a semver range  — keep the package within this range; "*" means any (track latest)
#                     e.g. "*", "^20", ">=1.18", "=1.3.1"
#   "dep"           — a transitive dependency; let resolution pick the version
#
# pkgm records new packages here for you. edit a value and save to change how a
# package is tracked; on a version conflict pkgm will ask you to edit this file.

`;

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
        Deno.env.get(
          "HOME",
        )
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
        assert_manifest_resolved();
        const prefix = install_prefix();
        const rv = await install(
          await combined_specs(prefix, args),
          prefix.string,
        );
        await record_install(prefix, args);
        console.log(rv.join("\n"));
      }
      break;
    case "local-install":
    case "li":
      if (install_prefix().string != "/usr/local") {
        const dst = Path.home().join(".local");
        await install(await combined_specs(dst, args), dst.string);
        await record_install(dst, args);
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
        assert_manifest_resolved();
        let all_success = true;
        for (const arg of args) {
          if (!(await uninstall(arg))) {
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
      assert_manifest_resolved();
      await update();
      break;

    case "pin":
      console.error("%cU EARLY! soz, not implemented", "color:red");
      Deno.exit(1);
      break;
    case "outdated":
      assert_manifest_resolved();
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
  const pkg_prefixes = json.pkgs.map(
    (x) => `${x.pkg.project}/v${x.pkg.version}`,
  );

  // get the pkgx_dir this way as it is a) more reliable and b) the only way if
  // we are running as sudo on linux since it doesn’t give us a good way to get
  // the home directory of the pre-sudo user
  const pkgx_dir = (() => {
    const { path, pkg } = json.pkgs[0]!;
    const remove = pkg.project + "/v" + pkg.version;
    return path.string.slice(0, -remove.length - 1);
  })();

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

        sh += "\n";
        //TODO should be specific with the project
        sh += dev_stub_text(to_stub, bin_prefix, entry.name);

        await Deno.remove(to_stub); //FIXME inefficient to symlink for no reason
        await Deno.writeTextFile(to_stub, sh.trim() + "\n");
        await Deno.chmod(to_stub, 0o755);

        rv.push(to_stub);
      }
    }
  }

  if (
    !Deno.env
      .get("PATH")
      ?.split(":")
      ?.includes(new Path(basePath).join("bin").string)
  ) {
    console.error(
      "%c! warning:",
      "color:yellow",
      `${new Path(basePath).join("bin")} not in $PATH`,
    );
  }

  return rv;
}

async function shim(args: string[], basePath: string) {
  const pkgx = get_pkgx();

  await ensureDir(join(basePath, "bin"));

  const json = (await query_pkgx(pkgx, args))[0];

  const args_pkgs: Record<string, semver.Range> = {};
  const projects_we_care_about: string[] = [];
  for (const arg of args) {
    const pkgs = await hooks.usePantry().find(arg);
    if (pkgs.length == 0) throw new Error(`no such pkg: ${arg}`);
    if (pkgs.length > 1) throw new Error(`ambiguous pkg: ${arg}`);
    args_pkgs[pkgs[0].project] = utils.pkg.parse(arg).constraint;
    projects_we_care_about.push(pkgs[0].project);
    const companions = await hooks.usePantry().project(pkgs[0]).companions();
    projects_we_care_about.push(...companions.map((x) => x.project));
  }

  for (const pkg of json.pkgs) {
    if (!projects_we_care_about.includes(pkg.pkg.project)) continue;

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

        const range = args_pkgs[pkg.pkg.project];
        const arg = `${pkg.pkg.project}${`${range}` == "*" ? "" : `${range}`}`;

        const shim = `#!${interpreter} --shebang --quiet +${arg} -- ${name}`;

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
    PATH: standardPath(),
  };
  const set = (key: string) => {
    const x = Deno.env.get(key);
    if (x) env[key] = x;
  };
  set("HOME");
  set("PKGX_DIR");
  set("PKGX_PANTRY_DIR");
  set("PKGX_DIST_URL");
  set("XDG_DATA_HOME");

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
  }).spawn();

  const status = await proc.status;

  if (!status.success) {
    Deno.exit(status.code);
  }

  const out = await proc.output();
  const json = JSON.parse(new TextDecoder().decode(out.stdout));

  const pkgs = (
    json.pkgs as { path: string; project: string; version: string }[]
  ).map((x) => {
    return {
      path: new Path(x.path),
      pkg: { project: x.project, version: new SemVer(x.version) },
    };
  });
  const pkg = pkgs.find((x) => `+${x.pkg.project}` == args[0])!;
  return [
    {
      pkg,
      pkgs,
      env: json.env,
      runtime_env: json.runtime_env,
    },
    env,
  ];
}

async function mirror_directory(dst: string, src: string, prefix: string) {
  let warned_copy_fallback = false;
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
      try {
        await Deno.link(sourcePath, targetPath);
      } catch {
        if (!warned_copy_fallback) {
          console.warn(
            "%c! hardlinking failed (possibly cross-device?), falling back to file copy",
            "color:yellow",
          );
          warned_copy_fallback = true;
        }
        await Deno.copyFile(sourcePath, targetPath);
      }
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
    if (name == "var") continue;
    if (!name.startsWith("v")) continue;
    if (/^v\d+$/.test(name)) continue; // pcre.org/v2
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

function expand_runtime_env(json: JsonResponse, basePath: string) {
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
  for (
    const {
      pkg: { project },
    } of json.pkgs
  ) {
    rv2[project] = rv;
  }

  return rv2;
}

function symlink_with_overwrite(src: string, dst: string) {
  // existsSync follows symlinks, so a *broken* one reads as absent and the
  // create below then fails with EEXIST (e.g. libpng’s `.la` symlinks during a
  // re-mirror). lstat sees the link itself; remove any symlink, broken or not.
  let stat;
  try {
    stat = Deno.lstatSync(dst);
  } catch {
    stat = undefined;
  }
  if (stat?.isSymlink) {
    Deno.removeSync(dst);
  }
  Deno.symlinkSync(src, dst);
}

function get_pkgx() {
  for (const path of Deno.env.get("PATH")!.split(":")) {
    const pkgx = join(path, "pkgx");
    if (existsSync(pkgx)) {
      const out = new Deno.Command(pkgx, { args: ["--version"] }).outputSync();
      const stdout = new TextDecoder().decode(out.stdout);
      const match = stdout.match(/^pkgx (\d+\.\d+\.\d+)/);
      if (!match || new SemVer(match[1]).lt(new SemVer("2.4.0"))) {
        Deno.exit(1);
      }
      return pkgx;
    }
  }
  throw new Error("no `pkgx` found in `$PATH`");
}

async function* ls() {
  for (
    const path of [
      new Path("/usr/local/pkgs"),
      Path.home().join(".local/pkgs"),
    ]
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
  let found: { project: string } | undefined;
  try {
    found = (await hooks.usePantry().find(arg))?.[0];
  } catch {
    console.error(
      "%c pantry not found, trying to find package another way",
      "color:blue",
    );
  }
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
    for await (const { path } of walk(pkgdir.string)) {
      const leaf = new Path(path).relative({ to: pkgdir });
      const resolved_path = root.join(leaf);
      // a second installed version (e.g. zlib 1.3.1 alongside 1.3.2) yields the
      // same resolved leaf; dedupe so we don’t try to remove it twice.
      if (set.has(resolved_path.string)) continue;
      set.add(resolved_path.string);
      // lstat, not exists() — exists() follows links, so a symlink pointing
      // into a sibling version dir we’re also removing reads as absent and gets
      // orphaned. lstat sees the link itself.
      let stat;
      try {
        stat = Deno.lstatSync(resolved_path.string);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
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
    try {
      Deno.removeSync(path.string);
    } catch {
      // already gone — tolerate (e.g. a leaf shared by two installed versions)
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

  try {
    apply_manifest(root, {}, [found.project]);
  } catch (err) {
    // manifest upkeep is best-effort; never fail an uninstall over it
    console.error(
      "%c! warning:",
      "color:yellow",
      `could not drop ${found.project} from ${manifest_path(root)}: ${
        err instanceof Error ? err.message : err
      }`,
    );
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

  const graph = await hydrate_graph(pkgs);

  for (const { path, pkg } of pkgs) {
    const range = graph[pkg.project];
    if (!range) continue; // orphan: not reachable from the requested set
    const versions = await hooks.useInventory().get(pkg);
    // console.log(pkg, range);
    const constrained_versions = versions.filter(
      (x) => range.satisfies(x) && x.gt(pkg.version),
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

  const graph = await hydrate_graph(pkgs);

  const update_list = [];

  for (const { pkg } of pkgs) {
    const range = graph[pkg.project];
    if (!range) continue; // orphan: not reachable from the requested set
    const versions = await hooks.useInventory().get(pkg);
    const constrained_versions = versions.filter(
      (x) => range.satisfies(x) && x.gt(pkg.version),
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

// where the manifest lives for a given install prefix. user installs follow XDG
// (config, since it’s hand-editable intent); the /usr/local prefix has no XDG
// home so it uses the FHS-conventional …/etc.
function manifest_path(prefix = install_prefix()): Path {
  if (prefix.string == "/usr/local") {
    return new Path("/usr/local/etc/pkgm/manifest.toml");
  }
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  const base = xdg ? new Path(xdg) : Path.home().join(".config");
  return base.join("pkgm/manifest.toml");
}

function read_manifest(
  prefix = install_prefix(),
): Record<string, string> | undefined {
  const path = manifest_path(prefix);
  if (!existsSync(path.string)) return undefined;
  const raw = parse_toml(Deno.readTextFileSync(path.string));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = `${value}`;
  }
  return out;
}

type ManifestEntryKind = "dep" | "requested" | "unresolved";

function manifest_entry_kind(value: string): ManifestEntryKind {
  if (value == "dep") return "dep";
  try {
    new semver.Range(value == "any" ? "*" : value);
    return "requested";
  } catch {
    return "unresolved";
  }
}

// "boot" check: refuse to operate when the manifest holds a value that is
// neither `dep` nor a valid semver range — i.e. a hand-edit that hasn’t been
// finished. no manifest at all → legacy behavior (see hydrate_graph), so
// existing installs keep working untouched.
function assert_manifest_resolved(prefix = install_prefix()) {
  const manifest = read_manifest(prefix);
  if (!manifest) return;
  const unresolved = Object.entries(manifest)
    .filter(([, value]) => manifest_entry_kind(value) == "unresolved")
    .map(([project]) => project);
  if (unresolved.length == 0) return;
  console.error(
    "%cerror",
    "color:red",
    `unresolved entries in ${manifest_path(prefix)}:`,
  );
  for (const project of unresolved) {
    console.error(`    ${project}`);
  }
  console.error(
    "edit the file, set each to `dep`, `*`, or a version, then re-run",
  );
  Deno.exit(1);
}

// resolve the constraint graph used by `outdated`/`update`. with a manifest we
// seed hydrate from the *requested* packages only and let it recompute the
// transitive deps coherently; without one we fall back to today’s behavior of
// assuming every installed package is pinned to its major version. an
// unreconcilable seed is dropped with a warning rather than aborting (#88).
async function hydrate_graph(
  pkgs: Installation[],
): Promise<Record<string, semver.Range>> {
  const manifest = read_manifest();
  const seeds = manifest
    ? Object.entries(manifest)
      .filter(([, value]) => value != "dep")
      .map(([project, value]) => ({
        project,
        constraint: new semver.Range(value == "any" ? "*" : value),
      }))
    : pkgs.map((x) => ({
      project: x.pkg.project,
      constraint: new semver.Range(`^${x.pkg.version}`),
    }));

  // installs can hold mutually-incompatible versions of a shared dep (e.g.
  // python pins zlib=1.3.1 while node pulled zlib^1.3.2); hydrate models a
  // single coherent universe and throws "cannot intersect". rather than let one
  // unreconcilable seed take down the whole command (the #88 symptom), drop the
  // seed that is one side of the conflict and re-resolve — the package is then
  // covered by its dependents’ constraints instead of our pin — accumulating a
  // warning for each so the user can fix or `dep` it.
  const dropped: { project: string; constraint: string }[] = [];
  let active = seeds;
  let raw_graph: { project: string; constraint: semver.Range }[];
  for (;;) {
    try {
      raw_graph = (await hydrate(active)).pkgs;
      break;
    } catch (err) {
      if (
        !(err instanceof Error) || !err.message.includes("cannot intersect")
      ) {
        throw err;
      }
      // err.message is "cannot intersect: <a> && <b>"; drop the seed whose
      // constraint is one of the two sides.
      const sides = err.message.match(
        /cannot intersect:\s*(.+?)\s*&&\s*(.+?)\s*$/,
      );
      const idx = sides
        ? active.findIndex((s) => {
          const t = `${s.constraint}`;
          return t == sides[1] || t == sides[2];
        })
        : -1;
      if (idx < 0) {
        // can’t attribute the conflict to one of our seeds; surface it raw.
        console.error("%cversion conflict", "color:red", err.message);
        if (manifest) {
          console.error(
            `  edit ${manifest_path()}: set the offending package to \`dep\`, or to a compatible version.`,
          );
        }
        Deno.exit(1);
      }
      dropped.push({
        project: active[idx].project,
        constraint: `${active[idx].constraint}`,
      });
      active = active.filter((_, i) => i != idx);
    }
  }

  if (dropped.length) {
    const where = manifest ? ` in ${manifest_path()}` : "";
    for (const { project, constraint } of dropped) {
      console.error(
        "%c! warning",
        "color:yellow",
        `\`${project}\` (${constraint}) can’t be reconciled with a dependency’s requirement; ignoring that pin — set \`${project}\` to \`dep\` or a compatible version${where} to silence this.`,
      );
    }
  }

  const graph: Record<string, semver.Range> = {};
  for (const { project, constraint } of raw_graph) {
    graph[project] = constraint;
  }
  return graph;
}

// edit the on-disk manifest as text so a user’s comments and hand-edits to
// untouched lines survive. entries in `set` are overwritten in place (or
// appended); projects in `remove` are dropped.
function apply_manifest(
  prefix: Path,
  set: Record<string, string>,
  remove: string[] = [],
) {
  const path = manifest_path(prefix);
  Deno.mkdirSync(dirname(path.string), { recursive: true });
  const text = existsSync(path.string)
    ? Deno.readTextFileSync(path.string)
    : MANIFEST_HEADER;

  const pending = new Map(Object.entries(set));
  const removing = new Set(remove);
  const key_re = /^\s*"([^"]+)"\s*=/;

  const out: string[] = [];
  for (const line of text.split("\n")) {
    const project = line.match(key_re)?.[1];
    if (project && removing.has(project)) continue;
    if (project && pending.has(project)) {
      out.push(`"${project}" = "${pending.get(project)}"`);
      pending.delete(project);
    } else {
      out.push(line);
    }
  }

  // append new entries directly after the existing ones — no separator blank,
  // or every install would add a gap. the single blank after the header comes
  // from MANIFEST_HEADER itself.
  let body = out.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  for (const [project, value] of pending) {
    body += `"${project}" = "${value}"\n`;
  }

  Deno.writeTextFileSync(path.string, body);
}

// fold the already-requested packages from the manifest into this install, so a
// shared dependency is resolved once across everything you’ve asked for rather
// than each install picking its own version and clobbering the link (#88: `i
// node` would relink zlib to 1.3.2, breaking python’s 1.3.1). new args win over
// a manifest entry for the same project. `dep`s are omitted — they’re recomputed
// from the requested set.
async function combined_specs(prefix: Path, args: string[]): Promise<string[]> {
  const manifest = read_manifest(prefix);
  // no args → let install() emit "no packages specified" rather than re-syncing.
  if (!manifest || args.length == 0) return args;

  const new_projects = new Set<string>();
  for (const arg of args) {
    try {
      const found = await hooks.usePantry().find(arg);
      if (found.length == 1) new_projects.add(found[0].project);
    } catch {
      // unresolved project name; the worst case is a duplicate spec, which
      // pkgx reconciles against the identical project anyway.
    }
  }

  const specs = [...args];
  for (const [project, value] of Object.entries(manifest)) {
    if (value == "dep" || new_projects.has(project)) continue;
    specs.push(value == "*" || value == "any" ? project : `${project}${value}`);
  }
  return specs;
}

// map each requested arg to its canonical project and the constraint you asked
// for. a bare name (`node`) yields `*` — track latest; a versioned spec
// (`node@22`) yields its range (`^22`). pantry hiccups are non-fatal: the
// package will still be picked up as a pin by record_install’s tree walk.
async function requested_constraints(
  args: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    let project: string | undefined;
    try {
      const found = await hooks.usePantry().find(arg);
      if (found.length == 1) project = found[0].project;
    } catch {
      continue;
    }
    if (!project) continue;
    out[project] = `${utils.pkg.parse(arg).constraint}`;
  }
  return out;
}

// keep the manifest in step with an install. requested packages record intent
// and overwrite: a bare name major-locks to what was installed (`^version`,
// matching pre-manifest `outdated`/`update` seeding), a versioned spec keeps the
// range you asked for (`node@22` → `^22`). every other package the install
// pulled in is recorded as `dep` — a transitive dependency with no constraint
// of its own, recomputed at resolution time. existing entries (e.g. a `dep` you
// promoted to a version by hand) are never clobbered.
async function record_install(prefix: Path, args: string[]) {
  try {
    const requested = await requested_constraints(args);
    const existing = read_manifest(prefix) ?? {};

    const greatest: Record<string, SemVer> = {};
    for await (const { pkg } of walk_pkgs(prefix.join("pkgs"))) {
      const cur = greatest[pkg.project];
      if (!cur || pkg.version.gt(cur)) greatest[pkg.project] = pkg.version;
    }

    const set: Record<string, string> = {};
    for (const [project, constraint] of Object.entries(requested)) {
      // a bare request parses to "*"; lock it to the installed major instead.
      set[project] = constraint == "*" && greatest[project]
        ? `^${greatest[project]}`
        : constraint;
    }

    // everything else now on disk is a transitive dependency: record it as
    // `dep`, carrying no constraint of its own. at compute time we hydrate the
    // requested (non-`dep`) entries, which pulls the whole installed graph back
    // in for collision detection, so deps don't need a recorded range.
    for (const project of Object.keys(greatest)) {
      if (project in requested || project in existing) continue;
      set[project] = "dep";
    }

    apply_manifest(prefix, set);
  } catch (err) {
    console.error(
      "%c! warning:",
      "color:yellow",
      `could not update ${manifest_path(prefix)}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

function dev_stub_text(selfpath: string, bin_prefix: string, name: string) {
  if (selfpath.startsWith("/usr/local") && selfpath != "/usr/local/bin/dev") {
    return `
dev_check() {
  [ -x /usr/local/bin/dev ] || return 1
  local d="$PWD"
  until [ "$d" = / ]; do
    if [ -f "${datadir()}/pkgx/dev/$d/dev.pkgx.activated" ]; then
      echo $d
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

if d="$(dev_check)"; then
  eval "$(/usr/local/bin/dev "$d" 2>/dev/null)"
  [ "$(command -v ${name} 2>/dev/null)" != "${selfpath}" ] && exec ${name} "$@"
fi

exec ${bin_prefix}/${name} "$@"
`.trim();
  } else {
    return `exec ${bin_prefix}/${name} "$@"`;
  }
}

function datadir() {
  const default_data_home = Deno.build.os == "darwin"
    ? "/Library/Application Support"
    : "/.local/share";
  return `\${XDG_DATA_HOME:-$HOME${default_data_home}}`;
}
