SHELL := /bin/sh
.PHONY: preflight guard lock prepare build verify require-tooling require-out require-store release attest
registry_flags = --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
SDK_VERSION := 0.0.19
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
lock: guard preflight
	@before=$$(shasum -a 256 frontend/pnpm-workspace.yaml); CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend install --lockfile-only $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) || exit $$?; test "$$before" = "$$(shasum -a 256 frontend/pnpm-workspace.yaml)" || { echo 'pnpm install rewrote frontend/pnpm-workspace.yaml' >&2; exit 65; }

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

require-tooling:
	@tool="$$(command -v soksak-sdk)" || { echo 'soksak-sdk is not selected by PATH' >&2; exit 78; }; \
		case "$$tool" in /*) ;; *) echo 'soksak-sdk PATH entry must be absolute' >&2; exit 78 ;; esac; \
		root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		test -f "$$tool" && test ! -L "$$tool" && test -f "$$root/release.json" && test ! -L "$$root/release.json" && test -d "$$root/.dependencies/soksak-spec" || { echo 'soksak-sdk PATH entry is not a prepared release' >&2; exit 78; }; \
		sdk_package_version="$$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$$root/package.json")"; \
		sdk_release_version="$$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$$root/release.json")"; \
		test "$$sdk_package_version" = "$(SDK_VERSION)" && test "$$sdk_release_version" = "$(SDK_VERSION)" || { echo "TOOLCHAIN_MISMATCH soksak-sdk required=$(SDK_VERSION) package=$$sdk_package_version release=$$sdk_release_version" >&2; exit 78; }

require-out:
	@case "$(origin OUT)" in "command line") ;; *) echo 'OUT must be an absolute command-line path to the complete release output' >&2; exit 64 ;; esac
	@case "$(OUT)" in /*) ;; *) echo 'OUT must be an absolute path' >&2; exit 64 ;; esac
	@test "$(OUT)" != "$(CURDIR)" || { echo 'OUT must not replace the source repository' >&2; exit 64; }

require-store:
	@case "$(origin STORE)" in "command line") ;; *) echo 'STORE must be an absolute command-line path to the local release store' >&2; exit 64 ;; esac
	@case "$(STORE)" in /*) ;; *) echo 'STORE must be an absolute path' >&2; exit 64 ;; esac
	@test -d "$(STORE)" && test ! -L "$(STORE)" || { echo 'STORE is not a regular directory' >&2; exit 66; }

release: require-tooling require-out require-store verify
	@test -z "$$(git status --porcelain)" || { echo 'release source checkout must be clean' >&2; exit 65; }
	@tool="$$(command -v soksak-sdk)"; tooling_root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		soksak-sdk package --root "$(CURDIR)" --spec-root "$$tooling_root/.dependencies/soksak-spec" \
		--commit "$$(git rev-parse --verify HEAD)" --store "$(STORE)" --out "$(OUT)"

attest: require-tooling require-out release
	@tool="$$(command -v soksak-sdk)"; tooling_root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		platform="$$(node -p 'process.platform')"; architecture="$$(node -p 'process.arch')"; \
		node_version="$$(node -p 'process.versions.node')"; pnpm_version="$$(pnpm --version)"; \
		soksak-sdk attest --release-dir "$(OUT)" \
		--spec-root "$$tooling_root/.dependencies/soksak-spec" --tooling-release "$$tooling_root/release.json" \
		--mode native --platform "$$platform" --architecture "$$architecture" \
		--tool "node=$$node_version" --tool "pnpm=$$pnpm_version"
