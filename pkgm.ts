#!/usr/bin/env -S pkgx --quiet deno^2.1 run --ext=ts --allow-sys=uid --allow-run --allow-env=PKGX_DIR,HOMEBREW_PREFIX,HOME --allow-read=/usr/local/pkgs
import { fromFileUrl, join } from "jsr:@std/path@^1";
import { ensureDir, existsSync } from "jsr:@std/fs@^1";
import { parse as parse_args } from "jsr:@std/flags@0.224.0";

function standardPath() {
  const basePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  // for pkgm installed via homebrew
  const homebrew = `${Deno.env.get("HOMEBREW_PREFIX") || "/opt/homebrew"}/bin`;
  if (Deno.build.os === "darwin") {
    return `${homebrew}:${basePath}`;
  } else {
    return basePath;
  }
}

const parsedArgs = parse_args(Deno.args, {
  alias: {
    v: "version",
    h: "help",
    p: "pin",
  },
  boolean: ["help", "version", "pin"],
});

if (parsedArgs.help) {
  console.log("https://github.com/pkgxdev/pkgm");
} else if (parsedArgs.version) {
  console.log("pkgm 0.0.0+dev");
} else {
  const args = parsedArgs._.map((x) => `${x}`).slice(1);

  switch (parsedArgs._[0]) {
    case "install":
    case "i":
      await install(args);
      break;
    case "uninstall":
    case "rm":
    case "list":
    case "ls":
    case "up":
    case "update":
    case "pin":
    case "outdated":
    case "stub":
      console.error("%cunimplemented. soz. U EARLY.", "color: red");
      Deno.exit(1);
      break;
    case "sudo-install": {
      const [pkgx_dir, runtime_env, ...paths] = args;
      const parsed_runtime_env = JSON.parse(runtime_env) as Record<
        string,
        Record<string, string>
      >;
      await sudo_install(pkgx_dir, paths, parsed_runtime_env);
      break;
    }
    default:
      if (Deno.args.length === 0) {
        console.error("https://github.com/pkgxdev/pkgm");
      } else {
        console.error("invalid usage");
      }
      Deno.exit(2);
  }
}

// Helper function to check directory exists 
// Deno.land recommended implementation to avoid race conditions.
async function dir_exists(path: string): Promise<boolean> {
  try {
    const fileInfo = await Deno.lstat(path);
    return fileInfo.isDirectory;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
    return false;
  }
}

async function install(args: string[]) {
  if (args.length === 0) {
    console.error("no packages specified");
    Deno.exit(1);
  }

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

  const proc = new Deno.Command("pkgx", {
    args: [...args, "--json=v1"],
    stdout: "piped",
    env,
    clearEnv: true,
  })
    .spawn();

  let status = await proc.status;

  if (!status.success) {
    Deno.exit(status.code);
  }

  const out = await proc.output();
  const json = JSON.parse(new TextDecoder().decode(out.stdout));
  // deno-lint-ignore no-explicit-any
  const pkg_prefixes = json.pkgs.map((x: any) => `${x.project}/v${x.version}`);

  const to_install = [];
  for (const prefix of pkg_prefixes) {
    if (!existsSync(join("/usr/local/pkgs", prefix))) {
      to_install.push(prefix);
    }
  }

  if (to_install.length === 0) {
    console.error("pkgs already installed");
    Deno.exit(0);
  }

  const self = fromFileUrl(import.meta.url);
  const pkgx_dir = Deno.env.get("PKGX_DIR") || `${Deno.env.get("HOME")}/.pkgx`;
  const needs_sudo = Deno.uid() != 0;

  const runtime_env = expand_runtime_env(json.runtime_env);

  args = [
    "pkgx",
    "deno^2.1",
    "run",
    "--ext=ts",
    "--allow-write", // cannot be qualified ∵ `Deno.link()` requires full access for some reason
    "--allow-read", //  same ^^ 😕
    self,
    "sudo-install",
    pkgx_dir,
    runtime_env,
    ...to_install,
  ];
  const cmd = needs_sudo ? "/usr/bin/sudo" : args.shift()!;
  status = await new Deno.Command(cmd, { args, env, clearEnv: true })
    .spawn().status;
  Deno.exit(status.code);
}

async function sudo_install(
  pkgx_dir: string,
  pkg_prefixes: string[],
  runtime_env: Record<string, Record<string, string>>,
) {
  const dst = "/usr/local";
  for (const pkg_prefix of pkg_prefixes) {
    // create /usr/local/pkgs/${prefix}
    await mirror_directory(join(dst, "pkgs"), pkgx_dir, pkg_prefix);
    // symlink /usr/local/pkgs/${prefix} to /usr/local
    if (!pkg_prefix.startsWith("pkgx.sh/v")) {
      // ^^ don’t overwrite ourselves
      // ^^ * https://github.com/pkgxdev/pkgm/issues/14
      // ^^ * https://github.com/pkgxdev/pkgm/issues/17
      await symlink(join(dst, "pkgs", pkg_prefix), dst);
    }
    // create v1, etc. symlinks
    await create_v_symlinks(join(pkgx_dir), join(dst, "pkgs"), pkg_prefix);;
  }

  for (const [project, env] of Object.entries(runtime_env)) {
    if (project == "pkgx.sh") continue;

    const pkg_prefix = pkg_prefixes.find((x) => x.startsWith(project))!;

    if (!pkg_prefix) continue; //FIXME wtf?

    for (const bin of ["bin", "sbin"]) {
      const bin_prefix = join("/usr/local/pkgs", pkg_prefix, bin);

      if (!existsSync(bin_prefix)) continue;

      for await (const entry of Deno.readDir(bin_prefix)) {
        if (!entry.isFile) continue;

        const to_stub = join("/usr/local", bin, entry.name);

        let sh = `#!/bin/sh\n`;
        for (const [key, value] of Object.entries(env)) {
          sh += `export ${key}="${value}"\n`;
        }
        sh += `exec "${bin_prefix}/${entry.name}" "$@"\n`;

        await Deno.remove(to_stub); //FIXME inefficient to symlink for no reason
        await Deno.writeTextFile(to_stub, sh);
        await Deno.chmod(to_stub, 0o755);
      }
    }
  }
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
      // Create a hard link for files
      await Deno.link(sourcePath, targetPath);
    } else if (fileInfo.isSymlink) {
      // Recreate symlink in the target directory
      const linkTarget = await Deno.readLink(sourcePath);
      await Deno.symlink(linkTarget, targetPath);
    } else {
      throw new Error(`unsupported file type at: ${sourcePath}`);
    }
  }
}

async function symlink(src: string, dst: string) {
  for (const base of ["bin", "sbin", "share", "lib", "libexec", "var", "etc"]) {
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
      await Deno.symlink(sourcePath, targetPath);
    }
  }
}

// Create all the version symbolic links based on those created by pkgx
// rather than reimplement using semver which cannot parse some package del /usr/local/pkgs/* && deno run --allow-env --allow-sys --allow-read --allow-run pkgm.ts install openssl@1.1.1ws
// https://github.com/pkgxdev/pkgm/issues/24
async function create_v_symlinks(src: string, dst: string, prefix: string) {
  // split prefix full version named dir from the rest
  const prefix_dir = prefix.split("/").slice(0, -1).join("/");
  const prefix_ver = prefix.split("/").reverse()[0];

  // pachage dirs in pkgx and pkgm (src to dst)
  const pkgx_dir = join(src, prefix_dir);
  const pkgm_dir = join(dst, prefix_dir);

  // the full path of newly installed pkg i.e including version part of path
  const main_ver_path = join(pkgm_dir, prefix_ver);
  // a relitive path version of above used for clean symbolic links
  const main_ver_rel = join(".", prefix_ver);

  // check the pkgx path is valid
  if (!dir_exists(pkgx_dir)) {
    console.log("Error: Could not find " + pkgx_dir);
  }

  // check that we have the package in pkgm
  if (!dir_exists(main_ver_path)) {
    console.log("Error: Could not find " + main_ver_path);
  }

  // look at all the symboloc links in pkgx and recreate them in pkgm
  // but using the main pkg dir under pkgm
  for await (const entry of Deno.readDir(pkgx_dir)) {
    if (
      entry.isSymlink && entry.name.startsWith("v") &&
      entry.name != "var"
    ) {
      await Deno.symlink(main_ver_rel, join(pkgm_dir, entry.name));
    }
  }
}

function expand_runtime_env(
  runtime_env: Record<string, Record<string, string>>,
) {
  const expanded: Record<string, Record<string, string>> = {};
  for (const [project, env] of Object.entries(runtime_env)) {
    const expanded_env: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const new_value = value.replaceAll(/\$?{{.*prefix}}/g, "/usr/local");
      expanded_env[key] = new_value;
    }
    expanded[project] = expanded_env;
  }
  return JSON.stringify(expanded);
}
