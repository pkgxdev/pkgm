#!/usr/bin/env -S pkgx deno^2.1 run --ext=ts --allow-sys=uid --allow-run=pkgx,/usr/bin/sudo --allow-env=PKGX_DIR,HOME --allow-read=/usr/local/pkgs
import { dirname, fromFileUrl, join } from "jsr:@std/path";
import { ensureDir, existsSync } from "jsr:@std/fs";
import { parse as parse_args } from "jsr:@std/flags";
import * as semver from "jsr:@std/semver";

const parsedArgs = parse_args(Deno.args, {
  alias: {
    v: "version",
    h: "help",
    p: "pin",
  },
  boolean: ["help", "version", "pin"],
});

if (parsedArgs.help) {
  const status = await new Deno.Command("pkgx", {
    args: ["gh", "repo", "view", "pkgxdev/pkgm"],
    clearEnv: true,
    env: {
      "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "HOME": Deno.env.get("HOME")!,
    },
  }).spawn().status;
  Deno.exit(status.code);
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
      const [pkgx_dir, ...paths] = args;
      await sudo_install(pkgx_dir, paths);
      break;
    }
    default:
      console.error("invalid usage");
      Deno.exit(2);
  }
}

async function install(args: string[]) {
  if (args.length === 0) {
    console.error("no packages specified");
    Deno.exit(1);
  }

  args = args.map((x) => `+${x}`);

  const env: Record<string, string> = {
    "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const set = (key: string) => {
    const x = Deno.env.get(key);
    if (x) env[key] = x;
  };
  set("HOME");
  set("PKGX_DIR");

  const proc = new Deno.Command("pkgx", {
    args: [...args, "--json"],
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

  if (needs_sudo) {
    args = [
      "pkgx",
      "deno^2.1",
      "run",
      "--ext=ts",
      "--allow-write", // cannot be qualified ∵ `Deno.link()` requires full access for some reason
      `--allow-read`, //  same ^^ 😕
      self,
      "sudo-install",
      pkgx_dir,
      ...to_install,
    ];
    const cmd = "/usr/bin/sudo";
    const status = await new Deno.Command(cmd, { args, env, clearEnv: true })
      .spawn().status;
    Deno.exit(status.code);
  } else {
    await sudo_install(pkgx_dir, to_install);
  }
}

async function sudo_install(pkgx_dir: string, pkg_prefixes: string[]) {
  const dst = "/usr/local";
  for (const pkg_prefix of pkg_prefixes) {
    // create /usr/local/pkgs/${prefix}
    await mirror_directory("/usr/local/pkgs", pkgx_dir, pkg_prefix);
    // symlink /usr/local/pkgs/${prefix} to /usr/local
    await symlink(join("/usr/local/pkgs", pkg_prefix), dst);
    // create v1, etc. symlinks
    await create_v_symlinks(join("/usr/local/pkgs", pkg_prefix));
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
  await processEntry(src, dst);

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
      await Deno.symlink(sourcePath, targetPath);
    }
  }
}

//FIXME we only do major as that's typically all pkgs need, but like we should do better
async function create_v_symlinks(prefix: string) {
  const shelf = dirname(prefix);

  const versions = [];
  for await (const entry of Deno.readDir(shelf)) {
    if (
      entry.isDirectory && !entry.isSymlink && entry.name.startsWith("v") &&
      entry.name != "var"
    ) {
      try {
        versions.push(semver.parse(entry.name));
      } catch {
        //ignore
      }
    }
  }

  // collect an Record of versions per major version
  const major_versions: Record<number, semver.SemVer> = {};
  for (const version of versions) {
    if (
      major_versions[version.major] === undefined ||
      semver.greaterThan(version, major_versions[version.major])
    ) {
      major_versions[version.major] = version;
    }
  }

  for (const [key, value] of Object.entries(major_versions)) {
    await Deno.symlink(`v${semver.format(value)}`, join(shelf, `v${key}`));
  }
}
