# `pkgm`

Install `pkgx` packages to `/usr/local`.

> [!CAUTION]
>
> `pkgm` is new software. Please report any issues you encounter and try it out
> in parallel with your current package manager.

> [!WARNING]
>
> `pkgm` is new software. Some features listed here are not yet implemented. You
> can help! Or we’ll get to it soon.

## Usage

```sh
$ pkgm install git
# ^^ installs latest git

$ pkgm install git@2.41
# ^^ installs git^2.41 or switches out the installed git to 2.41

$ pkgm uninstall git

$ pkgm list
# ^^ lists what is installed

$ pkgm outdated
# ^^ lists outdated installations

$ pkgm update
# ^^ updates installed packages to latest versions

$ pkgm pin git
# ^^ prevents the installed git from being updated
```

> [!NOTE]
>
> Commands call `sudo` as needed.

> [!TIP]
>
> - `pkgm i` is an alias for `pkgm install`
> - `pkgm rm` is an alias for `pkgm uninstall`
> - `pkgm ls` is an alias for `pkgm list`
> - `pkgm up` is an alias for `pkgm update`

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
- Installed packages are installed as `root`
