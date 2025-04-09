# `pkgm`

Install `pkgx` packages to `/usr/local`.

> [!CAUTION]
>
> `pkgm` is new software. Please report any issues you encounter and try it out
> in parallel with your current package manager.

## Usage

```sh
$ pkgm install node
# ^^ installs latest node to ~/.local. ie. you get ~/.local/bin/node

$ pkgm install node@20.1
# ^^ installs node^20.1 or switches out the installed node to 20.1

$ pkgm uninstall node

$ sudo pkgm install node
# ^^ installs node to /usr/local. ie. you get /usr/local/bin/node

$ pkgm shim node
# ^^ creates a shim for node at ~/.local/bin/node
# see the docs below for details about shims

$ pkgm list
# ^^ lists what’s installed

$ pkgm outdated
# ^^ lists outdated installations

$ pkgm update
# ^^ updates ~/.local packages to latest versions

$ sudo pkgm update
# ^^ updates /usr/local packages to latest versions
```

> [!TIP]
>
> - `pkgm i` is an alias for `pkgm install`
> - `pkgm rm` is an alias for `pkgm uninstall`
> - `pkgm ls` is an alias for `pkgm list`
> - `pkgm up` is an alias for `pkgm update`

> [!WARNING]
>
> You should probably `sudo pkgm install` rather than install to `~/.local`.
> This is because many other tools will not look in `~/.local` for packages
> _even_ if it’s in `PATH`. Having said this—by all means—see how it goes!

> ### Shims
>
> Shims are files with a single line, eg `#!/usr/bin/env -S pkgx -q! node@22`.
>
> Thus using the shell to invoke the program via `pkgx`. You get all the
> benefits of an installed package—but only installed on-demand. Useful for
> self-healing setups, devops, containers and plenty more one-off or ephemeral
> tasks.
>
> Shims are pretty great—but have caveats. Some software might be surprised that
> a package is not fully “installed” which can lead to unexpected errors. In
> practice we have seen issues only rarely and for more complex package
> combinations.

## Installation

```sh
brew install pkgxdev/made/pkgm || curl https://pkgx.sh | sh
```

## Uninstallation

```sh
brew rm pkgm || sudo rm /usr/local/bin/pkgm
```

# Intricacies

1. Packages are installed via `pkgx` to `~/.pkgx`
2. We then `sudo` hard-link them to `/usr/local/pkgs`
3. We then symlink the hard-links to `/usr/local`

# Advantages Over Homebrew

- Blazingly fast
- Install specific versions of any pkg
- You install by executable name—thus you _don’t have to do a search first_
- Installed packages can be installed as `root`
- `dev`-aware installations
- Optional self-healing shims
