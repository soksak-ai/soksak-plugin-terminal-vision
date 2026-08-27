SHELL := /bin/sh
.PHONY: preflight guard prepare build verify
registry_flags = --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
# REGISTRY is accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.
preflight:
	@scripts/check-build-environment.sh
# A package that depends on @soksak/* or @soksak-ai/* requires REGISTRY for every install, the public registry included.
guard:
	@case "$(origin REGISTRY)" in undefined|"command line") ;; *) echo 'REGISTRY from the $(origin REGISTRY) is refused: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY):$(REGISTRY)" in undefined:|"command line:http://"*|"command line:https://"*) ;; *) echo 'REGISTRY must be an absolute URL: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@dependency=$$(node -p 'const p=require("$(CURDIR)/frontend/package.json");Object.keys({...p.dependencies,...p.devDependencies,...p.peerDependencies}).find((name)=>/^@soksak(-ai)?\//.test(name))??""') || exit $$?; test -z "$$dependency" || test "$(origin REGISTRY)" = "command line" || { echo "REGISTRY required: this package depends on $$dependency: make verify REGISTRY=http://host:port/" >&2; exit 64; }
# A failed install exits with the pnpm status; the pnpm-workspace.yaml digest is compared only after a successful install.
prepare: guard preflight
	@before=$$(shasum -a 256 frontend/pnpm-workspace.yaml); CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend install --frozen-lockfile $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) || exit $$?; test "$$before" = "$$(shasum -a 256 frontend/pnpm-workspace.yaml)" || { echo 'pnpm install rewrote frontend/pnpm-workspace.yaml' >&2; exit 65; }
# pnpm 11 compares the settings recorded by the install before every script run and reinstalls
# without the registry flags on any difference. The run commands repeat the install environment and
# flags; the flags precede the script name so pnpm consumes them instead of the script.
build: prepare
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) build
verify: prepare
	@node scripts/check-release-workflow.mjs
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) verify
