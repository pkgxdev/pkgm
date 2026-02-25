type Platform = Deno.Build["os"];

export function datadir(os: Platform = Deno.build.os) {
  const defaultDataHome = os === "darwin"
    ? "/Library/Application Support"
    : "/.local/share";
  return `\${XDG_DATA_HOME:-$HOME${defaultDataHome}}`;
}

export function devStubText(
  selfpath: string,
  binPrefix: string,
  name: string,
  os: Platform = Deno.build.os,
) {
  if (selfpath.startsWith("/usr/local") && selfpath != "/usr/local/bin/dev") {
    return `
dev_check() {
  [ -x /usr/local/bin/dev ] || return 1
  local d="$PWD"
  until [ "$d" = / ]; do
    if [ -f "${datadir(os)}/pkgx/dev/$d/dev.pkgx.activated" ]; then
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

exec ${binPrefix}/${name} "$@"
`.trim();
  }

  return `exec ${binPrefix}/${name} "$@"`;
}
