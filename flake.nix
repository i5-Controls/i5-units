{
  description = "i5 unit registry, Rust generator, and Rust/Python/Node packages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      source = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter =
          path: type:
          nixpkgs.lib.cleanSourceFilter path type
          && !(builtins.elem (baseNameOf path) [
            "node_modules"
            "target"
            ".venv"
            "__pycache__"
            ".pytest_cache"
            ".ruff_cache"
            "result"
            "result-bin"
          ]);
      };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          version = (builtins.fromJSON (builtins.readFile ./registry.json)).version;
          rustPackage =
            args:
            pkgs.rustPlatform.buildRustPackage (
              {
                inherit version;
                src = source;
                cargoLock.lockFile = ./Cargo.lock;
              }
              // args
            );
          generator = rustPackage {
            pname = "i5-units-generator";
            cargoBuildFlags = [
              "-p"
              "i5-units-generator"
            ];
            cargoTestFlags = [
              "-p"
              "i5-units-generator"
            ];
            meta.mainProgram = "i5-units-generator";
          };
        in
        {
          inherit generator;
          default = generator;
          rust = rustPackage {
            pname = "i5-units";
            cargoBuildFlags = [
              "-p"
              "i5-units"
            ];
            cargoTestFlags = [
              "-p"
              "i5-units"
            ];
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib $out/share/i5-units
              find target -name 'libi5_units.rlib' -exec cp {} $out/lib/ \;
              cp -r rust/. $out/share/i5-units/
              cp Cargo.lock $out/share/i5-units/
              runHook postInstall
            '';
          };
          python = pkgs.python312Packages.buildPythonPackage {
            pname = "i5-units";
            inherit version;
            src = source;
            sourceRoot = "source/python";
            pyproject = true;
            build-system = [ pkgs.python312Packages.hatchling ];
            pythonImportsCheck = [ "i5_units" ];
            # Source/schema tests need the full repository and run via uv.
            doCheck = false;
          };
          node =
            pkgs.runCommand "i5-units-node-${version}"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
              }
              ''
                cp -r ${source} source
                chmod -R u+w source
                cd source
                mkdir -p $out/lib/node_modules/@i5controls/i5-units $out/share
                npm pack --ignore-scripts --offline --cache $TMPDIR/npm-cache --pack-destination $out/share
                tar -xf $out/share/*.tgz --strip-components=1 -C $out/lib/node_modules/@i5controls/i5-units
                node --input-type=module -e 'import { convert } from "./dist/typescript/index.js"; if (convert(1).from("s").to("µs") !== 1e6) process.exit(1)'
              '';
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          inherit (self.packages.${system}) rust python node;
          registry =
            pkgs.runCommand "i5-units-registry-check"
              {
                nativeBuildInputs = [
                  self.packages.${system}.generator
                  pkgs.nodejs_24
                ];
              }
              ''
                cp -r ${source} source
                chmod -R u+w source
                cd source
                export I5_UNITS_GENERATOR=${self.packages.${system}.generator}/bin/i5-units-generator
                node scripts/generate.mjs --check
                node --test scripts/generate.test.mjs
                touch $out
              '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              rustc
              rustfmt
              clippy
              nodejs_24
              pnpm
              python312
              uv
              git
            ];
            UV_PYTHON_DOWNLOADS = "never";
            UV_PYTHON = "${pkgs.python312}/bin/python3";
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
