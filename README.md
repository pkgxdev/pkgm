# `pkgm`

Install `pkgx` packages to `/usr/local`.

> [!WARNING]
>
> `pkgm` is new software. Please report any issues you encounter and try it out
> in parallel with your current package manager.

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

$ pkgm install git@2.43 --pin
# installs and pins git^2.43

$ pkgm stub git
# uninstalls git and installs stubs into bin instead
# see docs below for more info
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
sh <(curl https://pkgx.sh)
```

## Uninstallation

```sh
sudo rm /usr/local/bin/pkgm /usr/local/bin/pkgx
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

# `pkgm stub`

For larger packages or packages with large dependency trees, installing packages
pollutes your system with hundreds of files. To avoid this, you can install a
stub instead.

Stubs are tiny shell scripts that invoke the tool via `pkgx` instead. Generally
this works well. Sometimes it does not however hence it just an option.
